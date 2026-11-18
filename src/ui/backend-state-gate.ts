/** An older GET must never replace live state received while it was in flight. */
export class BackendStateGate {
  private generation = 0;
  private request = 0;
  beginSnapshot() {
    return { generation: this.generation, request: ++this.request };
  }
  liveEvent() {
    this.generation++;
  }
  accepts(snapshot: { generation: number; request: number }) {
    return snapshot.generation === this.generation && snapshot.request === this.request;
  }
}
