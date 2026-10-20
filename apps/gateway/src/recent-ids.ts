// The most recent ids added, forgetting the oldest beyond `limit` so a long-running gateway stays small.
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly limit: number) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  // False when the id was already there.
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    // Sets iterate in insertion order, so the first id is the oldest.
    if (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value!);
    return true;
  }
}
