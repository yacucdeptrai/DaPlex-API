const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Long } = require('bson');

function loadEnv(filePath) {
  return Object.fromEntries(
    fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !line.startsWith('#'))
      .map((line) => {
        const idx = line.indexOf('=');
        return idx > -1 ? [line.slice(0, idx), line.slice(idx + 1)] : [line, ''];
      })
  );
}

function encryptSecret(secret, cryptoKey) {
  const key = crypto.createHash('sha256').update(cryptoKey).digest('base64').substring(0, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes256', key, iv);
  const encrypted = cipher.update(secret, 'utf8', 'base64') + cipher.final('base64');
  return `${encrypted}.${iv.toString('base64')}`;
}

async function main() {
  const envPath = path.resolve(__dirname, '..', '.env');
  const env = loadEnv(envPath);

  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is missing in API .env');
  if (!env.CLOUDFLARE_R2_S3_KEY || !env.CLOUDFLARE_R2_S3_SECRET || !env.CLOUDFLARE_R2_API_URL) {
    throw new Error('Missing CLOUDFLARE_R2_* variables in API .env');
  }
  if (!env.CRYPTO_SECRET_KEY) throw new Error('CRYPTO_SECRET_KEY is missing in API .env');

  await mongoose.connect(env.DATABASE_URL, { family: 4 });
  const db = mongoose.connection.db;

  let settings = await db.collection('settings').findOne({});
  if (!settings) {
    const owner = await db.collection('users').findOne({}, { projection: { _id: 1 } });
    if (!owner?._id) throw new Error('No user found to assign as settings owner.');
    const now = Date.now();
    const settingId = Long.fromString((BigInt(now) * 4096n + BigInt(Math.floor(Math.random() * 4095))).toString());
    const settingDoc = {
      _id: settingId,
      owner: owner._id,
      mediaSourceStorages: [],
      linkedMediaSourceStorages: [],
      mediaSubtitleStorages: [],
      defaultVideoCodecs: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await db.collection('settings').insertOne(settingDoc);
    settings = settingDoc;
    console.log('Created missing settings document:', settingId.toString());
  }

  if (settings.mediaSourceStorages?.length) {
    console.log('mediaSourceStorages already configured:', settings.mediaSourceStorages.map((x) => x.toString()));
    return;
  }

  const now = Date.now();
  const snowflakeLike = (BigInt(now) * 4096n + BigInt(Math.floor(Math.random() * 4095))).toString();
  const storageId = Long.fromString(snowflakeLike);
  const encryptedSecret = encryptSecret(env.CLOUDFLARE_R2_S3_SECRET, env.CRYPTO_SECRET_KEY);

  await db.collection('externalstorages').insertOne({
    _id: storageId,
    name: 'R2 Media Source Storage',
    kind: 7,
    clientId: env.CLOUDFLARE_R2_S3_KEY,
    clientSecret: encryptedSecret,
    publicUrl: env.CLOUDFLARE_R2_API_URL,
    folderName: 'daplex',
    inStorage: 1,
    used: 0,
    files: [],
    createdAt: new Date(),
    updatedAt: new Date()
  });

  await db.collection('settings').updateOne(
    { _id: settings._id },
    { $set: { mediaSourceStorages: [storageId], updatedAt: new Date() } }
  );

  console.log('Created media source storage:', storageId.toString());
  console.log('Assigned to settings.mediaSourceStorages');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
