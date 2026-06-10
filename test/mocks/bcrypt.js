// Jest stub for the `bcrypt` package, which loads a platform-specific native
// addon. Only a Windows binary is present in this workspace, so importing
// bcrypt under the linux runner throws "invalid ELF header" before any spec
// runs. auth.service is the sole consumer (hash/compare) and no spec asserts
// real hashing, so this deterministic stub keeps modules that transitively
// import it (including MediaController via the auth guards) loadable. Wired in
// via jest.moduleNameMapper.
module.exports = {
  hash: (password) => Promise.resolve(`hashed:${password}`),
  compare: (password, hashed) => Promise.resolve(hashed === `hashed:${password}`),
  hashSync: (password) => `hashed:${password}`,
  compareSync: (password, hashed) => hashed === `hashed:${password}`,
  genSalt: () => Promise.resolve('salt'),
  genSaltSync: () => 'salt'
};
