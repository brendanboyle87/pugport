const api = window.pugport;
const $ = (id) => document.getElementById(id);
const [title, notes, status, retry, quote, discuss] = ['title', 'notes', 'status', 'retry', 'quote', 'discuss'].map($);
let revision = 0;
let saved = { title: '', notes: '' };
let timer, onRetry;
let saving = false, paused = false, attached = true; // a conflict waits for the user's choice
const values = () => ({ title: title.value, notes: notes.value });
const dirty = () => title.value !== saved.title || notes.value !== saved.notes;
function say(text, action, handler) {
  status.textContent = text;
  retry.hidden = !action;
  retry.textContent = action ?? '';
  onRetry = handler;
}
function enable(on) { for (const element of [title, notes, quote, discuss]) element.disabled = !on; }
function applyTheme({ theme, tokens }) {
  document.documentElement.style.colorScheme = theme;
  for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
}
function show(state) {
  revision = state.revision;
  saved = { title: state.values.title ?? '', notes: state.values.notes ?? '' };
  title.value = saved.title;
  notes.value = saved.notes;
}
async function save() {
  clearTimeout(timer);
  if (!attached || saving || paused) return false;
  if (!dirty()) return true;
  saving = true;
  say('Saving…');
  const snapshot = values();
  try {
    const result = await api.state.set({ values: snapshot, expectedRevision: revision });
    if (!attached) return false;
    revision = result.revision;
    saved = snapshot;
    say(dirty() ? '' : 'Saved');
    return !dirty();
  } catch (error) {
    if (!attached) return false;
    if (error.code === 'E_CONFLICT') {
      const latest = await api.state.get().catch(() => undefined);
      if (!attached) return false;
      if (latest) { revision = latest.revision; saved = { title: latest.values.title ?? '', notes: latest.values.notes ?? '' }; }
      paused = true;
      say('Also changed in another window.', 'Keep mine', () => { paused = false; void save(); });
    } else {
      say("Couldn't save. Your text is still here.", 'Try again', () => void save());
    }
    return false;
  } finally {
    saving = false;
    if (attached) {
      void api.ui.setDirty(dirty()).catch(() => {});
      if (dirty() && !paused && !retry.textContent) schedule();
    }
  }
}
function schedule() {
  if (!attached) return;
  void api.ui.setDirty(dirty()).catch(() => {});
  clearTimeout(timer);
  if (!paused) { say(''); timer = setTimeout(save, 800); }
}
async function addLatestReply() {
  try {
    const reply = (await api.messages.list({ limit: 20 })).filter((m) => m.role === 'assistant').at(-1);
    if (!attached) return;
    if (!reply) {
      say('No reply yet. Ask something in the chat.');
      await api.ui.chat({ open: true });
      return;
    }
    const quoted = reply.content.trim().slice(0, 1200).split('\n').map((line) => `> ${line}`).join('\n');
    notes.value = `${notes.value.trimEnd()}${notes.value.trim() ? '\n\n' : ''}${quoted}\n`;
    notes.focus();
    notes.selectionStart = notes.selectionEnd = notes.value.length;
    schedule();
  } catch {
    if (attached) say("Couldn't read the chat.");
  }
}
async function discussInChat() {
  if (!(await save()) || !attached) return;
  const body = notes.value.trim();
  if (!body) return void (notes.focus(), say('Write a note first.'));
  const heading = title.value.trim() ? `My notes on "${title.value.trim()}":` : 'My reading notes:';
  try {
    await api.composer.insert({ text: `${heading}\n\n${body}`.slice(0, 16000), mode: 'append' });
    if (attached) say('Added to your message. Review it, then send.');
  } catch {
    if (attached) say("Couldn't add to your message.");
  }
}
async function load() {
  say('Loading notes…');
  try {
    applyTheme(await api.host.info());
    const state = await api.state.get();
    if (!attached) return;
    show(state);
    enable(attached);
    say('');
  } catch {
    if (!attached) return;
    say("Couldn't load your notes.", 'Try again', () => void load());
  }
}
title.addEventListener('input', schedule);
notes.addEventListener('input', schedule);
retry.addEventListener('click', () => onRetry?.());
quote.addEventListener('click', () => void addLatestReply());
discuss.addEventListener('click', () => void discussInChat());
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void save();
  }
});
api.on('theme', applyTheme);
api.on('state', (state) => { if (attached && !dirty() && !saving) show(state); });
api.on('detached', () => {
  attached = false;
  clearTimeout(timer);
  enable(false);
  say('This Mod was removed from the chat.');
});
void load();
