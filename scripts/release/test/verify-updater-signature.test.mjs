import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseSignature, verifyUpdaterSignature } from '../verify-updater-signature.mjs';
import { withTempDir } from './helpers.mjs';

const b64 = (value) => Buffer.from(value).toString('base64');

// A minisign key pair in Tauri's encoding (base64 of minisign's text files).
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const pubkey = b64(`untrusted comment: minisign public key: ${keyId.toString('hex')}\n${b64(Buffer.concat([Buffer.from('Ed'), keyId, raw]))}\n`);
  return { pubkey, privateKey, keyId };
}

function signature({ privateKey, keyId }, data, trustedComment, { prehashed = true, tamper = false } = {}) {
  const message = prehashed ? createHash('blake2b512').update(data).digest() : data;
  const signed = sign(null, message, privateKey);
  const global = sign(null, Buffer.concat([signed, Buffer.from(trustedComment)]), privateKey);
  const comment = tamper ? trustedComment.replace('0.3.0', '0.3.1') : trustedComment;
  const algorithm = Buffer.from(prehashed ? 'ED' : 'Ed');
  return b64(`untrusted comment: signature from tauri secret key\n${b64(Buffer.concat([algorithm, keyId, signed]))}\ntrusted comment: ${comment}\n${b64(global)}\n`);
}

test('accepts prehashed and legacy signatures and checks the signed version', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'protocol-windows-x64-setup.exe');
    const data = randomBytes(100_000);
    writeFileSync(path, data);
    const keys = keyPair();
    const comment = 'timestamp:1792968929\tfile:protocol-windows-x64-setup.exe\tversion:0.3.0';
    for (const prehashed of [true, false]) {
      const signatureBase64 = signature(keys, data, comment, { prehashed });
      const parsed = await verifyUpdaterSignature({ publicKeyBase64: keys.pubkey, signatureBase64, path, expectedVersion: '0.3.0' });
      assert.equal(parsed.fields.version, '0.3.0');
      assert.equal(parsed.fields.file, 'protocol-windows-x64-setup.exe');
      await assert.rejects(
        verifyUpdaterSignature({ publicKeyBase64: keys.pubkey, signatureBase64, path, expectedVersion: '0.3.1' }),
        /signed for version 0\.3\.0, expected 0\.3\.1/,
      );
    }
  });
});

test('rejects another key, a changed file, an altered trusted comment and a missing version', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'payload');
    const data = randomBytes(1000);
    writeFileSync(path, data);
    const keys = keyPair();
    const comment = 'timestamp:1\tfile:payload\tversion:0.3.0';
    const good = signature(keys, data, comment);
    await assert.rejects(
      verifyUpdaterSignature({ publicKeyBase64: keyPair().pubkey, signatureBase64: good, path }),
      /signed by key/,
    );
    await assert.rejects(
      verifyUpdaterSignature({ publicKeyBase64: keys.pubkey, signatureBase64: signature(keys, Buffer.from('other'), comment), path }),
      /does not match the file/,
    );
    await assert.rejects(
      verifyUpdaterSignature({ publicKeyBase64: keys.pubkey, signatureBase64: signature(keys, data, comment, { tamper: true }), path }),
      /trusted comment was altered/,
    );
    const unversioned = signature(keys, data, 'timestamp:1\tfile:payload');
    await verifyUpdaterSignature({ publicKeyBase64: keys.pubkey, signatureBase64: unversioned, path });
    await assert.rejects(
      verifyUpdaterSignature({ publicKeyBase64: keys.pubkey, signatureBase64: unversioned, path, expectedVersion: '0.3.0' }),
      /signed for version \(none\)/,
    );
    assert.throws(() => parseSignature(b64('not a signature')), /not a base64-encoded minisign file/);
  });
});
