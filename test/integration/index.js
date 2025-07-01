const assert = require('assert');
const vscode = require('vscode');

describe('Extension Integration Test', function () {
  this.timeout(60000);

  it('should activate without errors', async () => {
    const extension = vscode.extensions.getExtension('cursor-tools.cursor-pocket-agent');
    assert.ok(extension);
    await extension.activate();
    assert.ok(extension.isActive);
  });
});