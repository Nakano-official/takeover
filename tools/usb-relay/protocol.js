function summaryLine(data) {
  if (!data || !['count', 'latest'].every(key =>
    Number.isInteger(data[key]) && data[key] >= 0 && data[key] <= 2147483647)) {
    throw new Error('Invalid GAS summary');
  }
  return `SUMMARY ${data.count} ${data.latest}`;
}
function relayUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' ||
      url.username || url.password || url.port || !url.pathname.endsWith('/exec')) {
    throw new Error('GASの /exec URLを指定してください。');
  }
  url.search = '?page=deviceRelay';
  url.hash = '';
  return url.href;
}
function isGasFrame(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      /^(?:[a-z0-9-]+-)?script\.googleusercontent\.com$/.test(url.hostname);
  } catch (_) { return false; }
}
module.exports = { summaryLine, relayUrl, isGasFrame };
