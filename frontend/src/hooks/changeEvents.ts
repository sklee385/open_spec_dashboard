export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
type Subscriber = { update: () => void; status?: (value: ConnectionStatus) => void };
const subscribers = new Set<Subscriber>();
let stream: EventSource | undefined;

// Keep one file-watcher connection per page, shared by the board and document views.
export function subscribeChangeEvents(update: () => void, status?: Subscriber['status']) {
  const subscriber = { update, status };
  subscribers.add(subscriber);
  if (!stream && typeof EventSource !== 'undefined') {
    stream = new EventSource('/api/events');
    const receive = () => { for (const listener of subscribers) { listener.status?.('connected'); listener.update(); } };
    stream.addEventListener('open', receive);
    stream.addEventListener('update', receive);
    stream.onerror = () => { for (const listener of subscribers) listener.status?.('disconnected'); };
  }
  return () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) { stream?.close(); stream = undefined; }
  };
}
