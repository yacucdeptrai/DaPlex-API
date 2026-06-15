// The driver's internal BSON entry point is deep-imported to monkey-patch
// resolveBSONOptions; it ships no declaration file. Declare it so the import
// type-checks without an inline `any` cast on the import statement.
declare module 'mongodb/lib/bson.js';
