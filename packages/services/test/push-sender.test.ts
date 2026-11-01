import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebPushSender, PUSH_SEND_TIMEOUT_MS } from '../src/index.js';

vi.mock('web-push', () => ({
  default: { sendNotification: vi.fn(), generateVAPIDKeys: vi.fn() },
}));

const send = vi.mocked(webpush.sendNotification);
const target = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/x',
  keys: { p256dh: 'p', auth: 'a' },
};
const payload = { title: 't', body: 'b', url: '/', tag: 'n1' };
const vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' };

describe('createWebPushSender', () => {
  beforeEach(() => {
    send.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the status of a successful send', async () => {
    send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await expect(createWebPushSender()(target, payload, vapid)).resolves.toEqual({
      statusCode: 201,
    });
  });

  it('passes the JSON payload with TTL 24 h, normal urgency, a 10 s timeout and the VAPID identity', async () => {
    send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await createWebPushSender()(target, payload, vapid);
    expect(send).toHaveBeenCalledExactlyOnceWith(target, JSON.stringify(payload), {
      TTL: 86_400,
      urgency: 'normal',
      timeout: 10_000,
      vapidDetails: vapid,
    });
  });

  it('turns a rejection by the push service into its status (410 is an answer, not a failure)', async () => {
    send.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 })),
    );
    await expect(createWebPushSender()(target, payload, vapid)).resolves.toEqual({
      statusCode: 410,
    });
  });

  it('rejects on a network or socket-timeout error (no status code)', async () => {
    send.mockImplementation(() => Promise.reject(new Error('Socket timeout')));
    await expect(createWebPushSender()(target, payload, vapid)).rejects.toThrow('Socket timeout');
  });

  it('rejects after 10 s when the request never settles', async () => {
    vi.useFakeTimers();
    send.mockReturnValue(new Promise(() => {}));
    const result = createWebPushSender()(target, payload, vapid);
    const assertion = expect(result).rejects.toThrow('push send timed out');
    await vi.advanceTimersByTimeAsync(PUSH_SEND_TIMEOUT_MS);
    await assertion;
  });
});
