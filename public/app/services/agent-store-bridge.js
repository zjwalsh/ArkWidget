export class AgentStoreBridge {
  constructor(wxccClient) {
    this.wxccClient = wxccClient;
    this.unsubscribeStore = null;
    this.unsubscribeSdk = null;
  }

  start(listener) {
    const store = window.$Store;

    if (store?.getState) {
      listener({
        source: "$Store",
        type: "snapshot",
        payload: sanitizeStoreState(store.getState())
      });
    } else {
      listener({
        source: "sdk",
        type: "snapshot",
        payload: this.wxccClient.getAgentSnapshot()
      });
    }

    if (store?.subscribe) {
      this.unsubscribeStore = store.subscribe(() => {
        listener({
          source: "$Store",
          type: "updated",
          payload: sanitizeStoreState(store.getState())
        });
      });
    }

    this.unsubscribeSdk = this.wxccClient.subscribeToDesktopEvents(listener);
  }

  stop() {
    this.unsubscribeStore?.();
    this.unsubscribeSdk?.();
  }
}

function sanitizeStoreState(state) {
  if (!state || typeof state !== "object") {
    return null;
  }

  return {
    agentSession: state.agentSession ?? null,
    agentContact: state.agentContact ?? null,
    agentProfile: state.agentProfile ?? null,
    taskMap: state.taskMap ?? null
  };
}
