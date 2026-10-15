//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';

/**
 * Export command — save this conversation as one self-contained HTML page to
 * share. The page and the dialog that asks what goes in it are host UI, so this
 * command only declares the intent; the host opens the dialog, the same one a
 * tab's "Export as HTML…" opens. Nothing in the conversation changes.
 */
class ExportConversationCommandType extends CommandType {
  static MANIFEST = {
    id: 'export',
    name: 'Export as HTML',
    version: '1.0.0',
    description: 'Save this conversation as a page to share',
    icon: 'icon-box'
  };

  /**
   * Ask the host for the export dialog.
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute() {
    return { handled: true, sideEffects: [{ type: 'openExportDialog' }] };
  }
}

export default ExportConversationCommandType;
