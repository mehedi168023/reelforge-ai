// The only door between the page and the PC: named calls, no Node in the page.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const listener = (_e, data) => fn(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('rfDesktop', {
  info: () => ipcRenderer.invoke('app:info'),
  fileUrl: (id, rel) => `app://reelforge/__files/${encodeURIComponent(id)}/${String(rel).split('/').map(encodeURIComponent).join('/')}`,
  put: (id, rel, data) => ipcRenderer.invoke('fs:put', id, rel, data),
  list: (id) => ipcRenderer.invoke('fs:list', id),
  exists: (id, rel) => ipcRenderer.invoke('fs:exists', id, rel),
  deleteAll: (id) => ipcRenderer.invoke('fs:deleteAll', id),
  reveal: (id, rel) => ipcRenderer.invoke('fs:reveal', id, rel),
  open: (id, rel) => ipcRenderer.invoke('fs:open', id, rel),
  saveAs: (id, rel, suggested) => ipcRenderer.invoke('fs:saveAs', id, rel, suggested),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  importFile: (id, src, name) => ipcRenderer.invoke('fs:import', id, src, name),
  onImportProgress: on('import:progress'),
  audioOf: (id, rel) => ipcRenderer.invoke('media:audio', id, rel),
  compose: (id, job) => ipcRenderer.invoke('engine:compose', id, job),
  waveform: (id, rel, points) => ipcRenderer.invoke('engine:waveform', id, rel, points),
  probe: (id, rel) => ipcRenderer.invoke('engine:probe', id, rel),
  onEngineProgress: on('engine:progress'),
  kvGet: (key) => ipcRenderer.invoke('kv:get', key),
  kvSet: (key, value) => ipcRenderer.invoke('kv:set', key, value),
  kvDel: (key) => ipcRenderer.invoke('kv:del', key),
  kvValues: (prefix) => ipcRenderer.invoke('kv:values', prefix),
  kvCount: () => ipcRenderer.invoke('kv:count'),
  kvImport: (entries) => ipcRenderer.invoke('kv:import', entries),
  historyAdd: (id, label, projectJson, indexHtml) => ipcRenderer.invoke('history:add', id, label, projectJson, indexHtml),
  historyList: (id) => ipcRenderer.invoke('history:list', id),
  historyGet: (hid) => ipcRenderer.invoke('history:get', hid),
  historyDrop: (id) => ipcRenderer.invoke('history:drop', id),
  detectEngines: () => ipcRenderer.invoke('engines:detect'),
  setTools: (tools) => ipcRenderer.invoke('mcp:setTools', tools),
  onToolCall: on('mcp:call'),
  toolResult: (callId, result) => ipcRenderer.send('mcp:result', callId, result),
  agentStart: (job) => ipcRenderer.invoke('agent:start', job),
  agentStop: (jobId) => ipcRenderer.invoke('agent:stop', jobId),
  onAgentEvent: on('agent:event'),
});
