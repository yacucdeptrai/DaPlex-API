// Jest stub for the `sharp` package, which loads a platform-specific native
// addon (libvips) downloaded at install time. The linux-x64 prebuilt binary is
// unavailable in this workspace, so importing sharp crashes the runner before
// any spec runs. Specs do not exercise real image processing, so this chainable
// no-op stub keeps modules that import sharp (average-color.util, the upload
// interceptor, and transitively MediaController) loadable. Wired in via
// jest.moduleNameMapper.
const pipeline = () => {
  const chain = {
    resize: () => chain,
    extend: () => chain,
    flatten: () => chain,
    toFormat: () => chain,
    toColorspace: () => chain,
    raw: () => chain,
    metadata: () => Promise.resolve({ width: 0, height: 0, format: 'png', pages: 1 }),
    toBuffer: () => Promise.resolve(Buffer.alloc(0)),
    toFile: () => Promise.resolve({})
  };
  return chain;
};

module.exports = pipeline;
module.exports.default = pipeline;
