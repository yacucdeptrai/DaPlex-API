// Jest stub for the `stream-mmmagic` package (which loads the native `mmmagic`
// addon). The prebuilt native binary is compiled for a specific Node ABI and
// fails to load under a different Node version in the test runner. Specs do not
// exercise libmagic file-type detection, so this no-op stub keeps modules that
// import it loadable. Wired in via jest.moduleNameMapper.
module.exports = {
  default: () => Promise.resolve([{ type: 'application/octet-stream' }, { unpipe: () => {} }])
};
