const { expect } = require('chai');
const path = require('path');
const { validateConfig } = require(path.join('..', 'src', 'util', 'config'));

describe('validateConfig', () => {
    it('accepts valid configuration', () => {
        const { errors, validated } = validateConfig({
            serverUrl: 'http://localhost:3300',
            pollInterval: 5000,
            cursorDebugPort: 9223,
        });
        expect(errors).to.be.an('array').that.is.empty;
        expect(validated).to.have.property('serverUrl', 'http://localhost:3300');
        expect(validated).to.have.property('pollInterval', 5000);
        expect(validated).to.have.property('cursorDebugPort', 9223);
    });

    it('rejects invalid URL', () => {
        const { errors } = validateConfig({
            serverUrl: 'notaurl',
            pollInterval: 5000,
            cursorDebugPort: 9223,
        });
        expect(errors).to.not.be.empty;
    });

    it('rejects too-low pollInterval', () => {
        const { errors } = validateConfig({
            serverUrl: 'http://localhost:3300',
            pollInterval: 500,
            cursorDebugPort: 9223,
        });
        expect(errors).to.not.be.empty;
    });

    it('rejects invalid debug port', () => {
        const { errors } = validateConfig({
            serverUrl: 'http://localhost:3300',
            pollInterval: 5000,
            cursorDebugPort: -1,
        });
        expect(errors).to.not.be.empty;
    });
});