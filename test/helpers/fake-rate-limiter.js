export class FakeRateLimiter {
    constructor(outcomes = [{ success: true }]) {
        this.outcomes = [...outcomes]
        this.calls = []
    }

    async limit(options = {}) {
        this.calls.push(structuredClone(options))
        return this.outcomes.length > 1
            ? this.outcomes.shift()
            : this.outcomes[0] ?? { success: true }
    }
}
