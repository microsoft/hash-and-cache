let task = require('./lib');
const { when } = require('jest-when');

// beforeEach(() => {
//     console.log = jest.fn();
// })

afterEach(() => {
    jest.restoreAllMocks();
})

describe('In options', () => {

    let globVariables = ['sourceFiles', 'outputFiles', 'outputIgnore'];
    let pathVariables = ['sourcePath', 'execWorkingDirectory', 'outputPath'];

    beforeEach(() => {
        task.tl.getPathInput = jest.fn();
        when(task.tl.getPathInput).calledWith('sourcePath').mockReturnValue('hi');
        when(task.tl.getPathInput).calledWith('execWorkingDirectory').mockReturnValue('hi');
        when(task.tl.getPathInput).calledWith('sourcePath').mockReturnValue('hi');
    });

    test('a glob parses into array', () => {
        const input = 'glob1';
        const output = [input]
        task.tl.getInput = jest.fn();
        globVariables.forEach(e => {
            when(task.tl.getInput).calledWith(e).mockReturnValue(input);
            expect(task.resolveOptions()[e]).toEqual(output);
        });
    });

    test('multiple globs parse into array', () => {
        const input = 'glob1\nglob2';
        const output = input.split(/\r?\n/);
        task.tl.getInput = jest.fn();
        globVariables.forEach(e => {
            when(task.tl.getInput).calledWith(e).mockReturnValue(input);
            expect(task.resolveOptions()[e]).toEqual(output);
        });
    });

    test('empty parses into array of empty string', () => {
        const input = null;
        const output = [''];
        task.tl.getInput = jest.fn();
        globVariables.forEach(e => {
            when(task.tl.getInput).calledWith(e).mockReturnValue(input);
            expect(task.resolveOptions()[e]).toEqual(output);
        });
    });

    test('empty paths resolve to cwd', () => {
        const input = null;
        const output = process.cwd();
        task.tl.getPathInput = jest.fn();
        pathVariables.forEach(e => {
            when(task.tl.getPathInput).calledWith(e).mockReturnValue(input);
            expect(task.resolveOptions()[e]).toEqual(output);
        });
    })

});

describe('Create blob service', () => {

    test('throws with null parameters', () => {
        task.azureStorage.createBlobService = jest.fn();

        expect(() => task.getGlobalBlobService('a', 'b', null)).toThrow();
        expect(() => task.getGlobalBlobService('a', null, 'c')).toThrow();
        expect(() => task.getGlobalBlobService(null, 'b', 'c')).toThrow();
    });

    test('returns blob', () => {
        const returnValue = 'fakeBlobService';
        task.azureStorage.createBlobService = jest.fn().mockReturnValueOnce(returnValue);

        expect(task.getGlobalBlobService('a', 'b', 'c')).toEqual(returnValue);
    });

});

describe('Cache operations', () => {

    beforeEach(() => {
        task.tar.extract = jest.fn();
        task.fs.unlinkSync = jest.fn();

        task.getGlobalBlobService = jest.fn().mockReturnValue({
            createBlockBlobFromLocalFile : jest.fn(),
            doesBlobExist : jest.fn(),
            getBlobToLocalFile : jest.fn()
        })
    });

    test('extract cache calls tar with correct args', () => {
        const pathTo = 'pathTo';
        const hash = 'hash';
        
        task.extractCache(pathTo, hash);
        expect(task.tar.extract.mock.calls[0][0].file).toEqual(`${pathTo}\\${hash}.tgz`);
        expect(task.tar.extract.mock.calls[0][0].cwd).toEqual(pathTo);
    });

});