const DEFAULT_BASE_URL = 'https://api.chatwork.com/v2';

function buildUrl(baseUrl, path, query = {}) {
  const url = new URL(`${baseUrl}${path}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return url;
}

export class ChatworkClient {
  constructor({ token, baseUrl = DEFAULT_BASE_URL }) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(method, path, { query = {}, form = {} } = {}) {
    const url = buildUrl(this.baseUrl, path, query);
    const headers = {
      Accept: 'application/json',
      'X-ChatWorkToken': this.token,
    };

    let body;
    if (method !== 'GET') {
      const formBody = new URLSearchParams();
      Object.entries(form).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        formBody.set(key, String(value));
      });
      body = formBody;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const response = await fetch(url, { method, headers, body });
    const rawText = await response.text();

    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = rawText;
      }
    }

    if (!response.ok) {
      const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
      throw new Error(`ChatWork API ${response.status}: ${detail}`);
    }

    return payload;
  }

  getMe() {
    return this.request('GET', '/me');
  }

  getRooms() {
    return this.request('GET', '/rooms');
  }

  getRoomMessages(roomId, { force = 1 } = {}) {
    return this.request('GET', `/rooms/${roomId}/messages`, { query: { force } });
  }

  postRoomMessage(roomId, { body }) {
    return this.request('POST', `/rooms/${roomId}/messages`, { form: { body } });
  }
}
