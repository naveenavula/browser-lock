chrome.runtime.sendMessage({ type: 'status' }, (s) => {
  if (s?.unlocked) {
    document.getElementById('who').textContent = `Signed in as ${s.email}`;
    document.getElementById('exp').textContent = `Locks again at ${new Date(s.expiresAt).toLocaleTimeString()}`;
  } else {
    document.getElementById('who').textContent = 'Locked';
  }
});

document.getElementById('lock').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'lock' }, () => window.close());
});
