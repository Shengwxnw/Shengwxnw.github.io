export class UrlHistory {
  private list: string[] = [];
  private idx = -1;

  push(url: string) {
    if (!url) return;
    // truncate forward history
    if (this.idx < this.list.length - 1) {
      this.list = this.list.slice(0, this.idx + 1);
    }
    this.list.push(url);
    this.idx = this.list.length - 1;
  }

  back(): string {
    if (this.idx > 0) this.idx--;
    return this.list[this.idx] ?? '';
  }

  forward(): string {
    if (this.idx < this.list.length - 1) this.idx++;
    return this.list[this.idx] ?? '';
  }

  current(): string {
    return this.list[this.idx] ?? '';
  }

  replace(url: string) {
    if (!url) return;
    if (this.idx >= 0 && this.idx < this.list.length) {
      this.list[this.idx] = url;
    }
  }
}

