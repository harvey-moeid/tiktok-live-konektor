import test from 'node:test';
import assert from 'node:assert/strict';
import { EULER_BUSINESS_PLAN_MESSAGE, isEulerBusinessPlanError } from '../server/signing-error.js';

test('recognizes the Euler signature Business-plan denial from SDK logs', () => {
  assert.equal(isEulerBusinessPlanError(
    '[Empty Payload] [fetchWebcastSignatureFromEulerRoute] Failed to sign a request: This endpoint requires a Business plan. Purchase one at https://www.eulerstream.com/pricing.'
  ), true);
});
test('recognizes wrapped and nested signer failures', () => {
  const cause = new Error('This endpoint requires a Business plan.');
  assert.equal(isEulerBusinessPlanError({ message: 'Request failed', info: { route: 'fetchWebcastSignatureFromEulerRoute' }, cause }), true);
});
test('does not misclassify ordinary TikTok connection errors', () => {
  for (const message of ['Room ID not found', 'Request timed out', '403 Forbidden', 'User is not live']) {
    assert.equal(isEulerBusinessPlanError({ message }), false);
  }
});
test('commercial entitlement guidance does not claim free key or Room ID can fix signing', () => {
  assert.match(EULER_BUSINESS_PLAN_MESSAGE, /Business/);
  assert.match(EULER_BUSINESS_PLAN_MESSAGE, /Community/);
  assert.match(EULER_BUSINESS_PLAN_MESSAGE, /tidak dijamin/);
});
