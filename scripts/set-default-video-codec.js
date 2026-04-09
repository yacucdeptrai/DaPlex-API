require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.DATABASE_URL, { family: 4 });
  const db = mongoose.connection.db;

  const result = await db.collection('settings').updateOne(
    { $or: [{ defaultVideoCodecs: { $exists: false } }, { defaultVideoCodecs: { $lte: 0 } }] },
    { $set: { defaultVideoCodecs: 1 } }
  );

  const setting = await db.collection('settings').findOne({}, { projection: { defaultVideoCodecs: 1 } });
  console.log('matched:', result.matchedCount, 'modified:', result.modifiedCount);
  console.log('defaultVideoCodecs:', setting?.defaultVideoCodecs);
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
