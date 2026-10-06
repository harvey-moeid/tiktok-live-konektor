import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRoomIdFromHtml } from '../server/tiktok.js';

test('extracts roomId from TikTok JSON', () => {
  assert.equal(extractRoomIdFromHtml('<script>{"roomId":"123456789012345"}</script>'), '123456789012345');
});

test('extracts room_id variant', () => {
  assert.equal(extractRoomIdFromHtml('window.x={"room_id":123456789012345}'), '123456789012345');
});

test('extracts escaped roomId from embedded JSON string', () => {
  const html = String.raw`<script>{"payload":"{\"roomId\":\"7693584931198438164\"}"}</script>`;
  assert.equal(extractRoomIdFromHtml(html), '7693584931198438164');
});

test('extracts HTML-entity encoded roomId', () => {
  const html = '<script>{&quot;roomId&quot;:&quot;7693584931198438164&quot;}</script>';
  assert.equal(extractRoomIdFromHtml(html), '7693584931198438164');
});

test('does not accept short numeric ids', () => {
  assert.equal(extractRoomIdFromHtml('{"roomId":"1234"}'), '');
});

test('does not mistake a generic object id for a LIVE room id', () => {
  assert.equal(extractRoomIdFromHtml('{"id":"7499912345678901234","uniqueId":"streamer"}'), '');
});
