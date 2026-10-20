//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package wireschema

import (
	"bufio"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
)

// sourceIndex is what reflection cannot see — doc comments and the constants
// declared of a type — read from the source of the packages a rendering
// reaches, each parsed once.
type sourceIndex struct {
	root    string // module root directory; "" when it was not found
	modPath string // the module's import path
	pkgs    map[string]*pkgSource
}

// pkgSource is one package's declarations, by type name.
type pkgSource struct {
	typeDocs  map[string][]string
	fieldDocs map[string]map[string]string
	consts    map[string][]constDecl
	inTest    map[string]bool // types declared in a _test.go file
}

// constDecl is one typed constant: its value as a literal type, or literal
// false when the value is not a literal (iota, an expression), which makes
// the type's constant set unusable.
type constDecl struct {
	value   string
	literal bool
	inTest  bool
}

// ModuleRoot returns the directory holding the go.mod of the module the
// working directory is in, and that module's path.
func ModuleRoot() (dir, modPath string) {
	wd, err := os.Getwd()
	if err != nil {
		return "", ""
	}
	for d := wd; ; d = filepath.Dir(d) {
		if f, err := os.Open(filepath.Join(d, "go.mod")); err == nil {
			sc := bufio.NewScanner(f)
			for sc.Scan() {
				if rest, ok := strings.CutPrefix(sc.Text(), "module "); ok {
					modPath = strings.TrimSpace(rest)
					break
				}
			}
			_ = f.Close()
			return d, modPath
		}
		if filepath.Dir(d) == d {
			return "", ""
		}
	}
}

func newSourceIndex() *sourceIndex {
	root, modPath := ModuleRoot()
	return &sourceIndex{root: root, modPath: modPath, pkgs: map[string]*pkgSource{}}
}

// pkg parses the package at pkgPath, or returns nil for one outside the
// module.
func (s *sourceIndex) pkg(pkgPath string) *pkgSource {
	if p, ok := s.pkgs[pkgPath]; ok {
		return p
	}
	var p *pkgSource
	if rel, ok := s.relDir(pkgPath); ok {
		p = parsePackage(filepath.Join(s.root, rel))
	}
	s.pkgs[pkgPath] = p
	return p
}

func (s *sourceIndex) relDir(pkgPath string) (string, bool) {
	if s.root == "" || s.modPath == "" {
		return "", false
	}
	if pkgPath == s.modPath {
		return ".", true
	}
	rel, ok := strings.CutPrefix(pkgPath, s.modPath+"/")
	return filepath.FromSlash(rel), ok
}

// typeDoc is t's doc comment, a line per element.
func (s *sourceIndex) typeDoc(t reflect.Type) []string {
	if p := s.pkg(t.PkgPath()); p != nil {
		return p.typeDocs[t.Name()]
	}
	return nil
}

// fieldDoc is the comment on t's field, on one line.
func (s *sourceIndex) fieldDoc(t reflect.Type, fieldName string) string {
	if p := s.pkg(t.PkgPath()); p != nil {
		return p.fieldDocs[t.Name()][fieldName]
	}
	return ""
}

// constants are the values of the typed constants t's package declares of
// it, as literal types — nil when it declares none, or any it declares is not
// a literal. Constants in test files count only for a type declared in one.
func (s *sourceIndex) constants(t reflect.Type) []string {
	p := s.pkg(t.PkgPath())
	if p == nil || t.Name() == "" {
		return nil
	}
	var out []string
	for _, c := range p.consts[t.Name()] {
		if c.inTest && !p.inTest[t.Name()] {
			continue
		}
		if !c.literal {
			return nil
		}
		out = append(out, c.value)
	}
	return out
}

func parsePackage(dir string) *pkgSource {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	p := &pkgSource{
		typeDocs:  map[string][]string{},
		fieldDocs: map[string]map[string]string{},
		consts:    map[string][]constDecl{},
		inTest:    map[string]bool{},
	}
	fset := token.NewFileSet()
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.ParseComments)
		if err != nil {
			continue
		}
		p.add(f, strings.HasSuffix(name, "_test.go"))
	}
	return p
}

func (p *pkgSource) add(f *ast.File, inTest bool) {
	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok {
			continue
		}
		switch gd.Tok {
		case token.TYPE:
			for _, spec := range gd.Specs {
				p.addType(gd, spec.(*ast.TypeSpec), inTest)
			}
		case token.CONST:
			p.addConsts(gd, inTest)
		}
	}
}

func (p *pkgSource) addType(gd *ast.GenDecl, ts *ast.TypeSpec, inTest bool) {
	name := ts.Name.Name
	p.inTest[name] = inTest
	doc := ts.Doc
	if doc == nil && len(gd.Specs) == 1 {
		doc = gd.Doc
	}
	if doc != nil {
		p.typeDocs[name] = docLines(doc.Text())
	}
	st, ok := ts.Type.(*ast.StructType)
	if !ok {
		return
	}
	docs := map[string]string{}
	for _, fld := range st.Fields.List {
		cg := fld.Doc
		if cg == nil {
			cg = fld.Comment
		}
		if cg == nil {
			continue
		}
		text := oneLine(cg.Text())
		for _, n := range fld.Names {
			docs[n.Name] = text
		}
	}
	p.fieldDocs[name] = docs
}

// addConsts records a const block's typed constants. A spec with neither type
// nor values repeats the one before it, which is iota's form, so it is never
// a literal.
func (p *pkgSource) addConsts(gd *ast.GenDecl, inTest bool) {
	var typeName string
	for _, spec := range gd.Specs {
		vs := spec.(*ast.ValueSpec)
		repeated := vs.Type == nil && len(vs.Values) == 0
		if !repeated {
			typeName = ""
			if id, ok := vs.Type.(*ast.Ident); ok {
				typeName = id.Name
			}
		}
		if typeName == "" {
			continue
		}
		for i := range vs.Names {
			c := constDecl{inTest: inTest}
			if !repeated && i < len(vs.Values) {
				c.value, c.literal = literalOf(vs.Values[i])
			}
			p.consts[typeName] = append(p.consts[typeName], c)
		}
	}
}

// literalOf renders a basic literal as a JS literal type.
func literalOf(e ast.Expr) (string, bool) {
	lit, ok := e.(*ast.BasicLit)
	if !ok {
		return "", false
	}
	switch lit.Kind {
	case token.STRING:
		s, err := strconv.Unquote(lit.Value)
		if err != nil {
			return "", false
		}
		return jsString(s), true
	case token.INT, token.FLOAT:
		return lit.Value, true
	}
	return "", false
}

// docLines splits a doc comment into lines safe inside a JSDoc block.
func docLines(text string) []string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	for i, l := range lines {
		lines[i] = jsdocSafe(l)
	}
	return lines
}

func oneLine(text string) string {
	return jsdocSafe(strings.Join(strings.Fields(text), " "))
}

// jsdocSafe keeps comment text from closing the block or opening a tag.
func jsdocSafe(s string) string {
	s = strings.ReplaceAll(s, "*/", "*\\/")
	if strings.HasPrefix(strings.TrimSpace(s), "@") {
		s = "\\" + strings.TrimSpace(s)
	}
	return s
}
