// Tests for how the final verdict is combined. Fail-closed paths matter most here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalVerdict } from '../assess.mjs';

const facts = (flags = [], extra = {}) => ({ flags: flags.map(severity => ({ severity })), ...extra });
const model = (verdict, findings = []) => ({ verdict, findings: findings.map(severity => ({ severity })) });

test('the verdict is the highest of the model, its findings and the flags', () => {
  assert.equal(finalVerdict(model('low'), facts()), 'low');
  assert.equal(finalVerdict(model('low'), facts(['medium'])), 'medium');
  assert.equal(finalVerdict(model('medium'), facts(['high'])), 'high');
  assert.equal(finalVerdict(model('high'), facts(['low'])), 'high', 'flags never lower the verdict');
  assert.equal(finalVerdict(model('low', ['high']), facts()), 'high', 'a high finding raises a low verdict');
});

test('anything unrecognised fails closed', () => {
  assert.equal(finalVerdict(model('toString'), facts()), 'high');
  assert.equal(finalVerdict(model('low', ['toString']), facts()), 'high');
  assert.equal(finalVerdict(model('low', ['bogus']), facts()), 'high');
  assert.equal(finalVerdict(model('low'), facts(['__proto__'])), 'high');
  assert.equal(finalVerdict(undefined, facts()), 'high');
  assert.equal(finalVerdict({ verdict: 'low', findings: [null] }, facts()), 'high');
});

test('a truncated context cannot be low', () => {
  assert.equal(finalVerdict(model('low'), facts([], { truncated: true })), 'medium');
  assert.equal(finalVerdict(model('high'), facts([], { truncated: true })), 'high');
});
