export class WorkQueue {
  constructor(concurrency = 4, capacity = 200) {
    this.concurrency = concurrency;
    this.capacity = capacity;
    this.active = 0;
    this.pending = [];
  }
  run(work) {
    if (this.active >= this.concurrency && this.pending.length >= this.capacity) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      this.pending.push({ work, resolve, reject });
      this.drain();
    });
  }
  drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const { work, resolve, reject } = this.pending.shift();
      this.active++;
      Promise.resolve().then(work).then(() => resolve(true), reject).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}
