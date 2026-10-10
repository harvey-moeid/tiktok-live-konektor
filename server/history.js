/**
 * Dashboard history removal is intentionally separate from LIVE event processing.
 * Deletion must not modify counters, gift streaks, connection state or webhook output.
 */
export function removeHistoryEvent(events, id) {
  if (typeof id !== 'string' || !id.trim() || id.trim() !== id || id.length > 128) {
    return { status: 'invalid', events };
  }
  const index = events.findIndex(event => event?.id === id);
  if (index === -1) return { status: 'missing', events };
  return { status: 'removed', events: events.filter((_, position) => position !== index) };
}
