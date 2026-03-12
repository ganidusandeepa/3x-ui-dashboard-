class PanelAPI {
    constructor() {
        this.baseUrl = window.location.origin; // Local backend node server
    }

    async getStatus() {
        const response = await fetch(`${this.baseUrl}/api/status`);
        return await response.json();
    }

    async getInbounds() {
        const response = await fetch(`${this.baseUrl}/api/inbounds`);
        return await response.json();
    }

    async getClientTraffic(email) {
        const response = await fetch(`${this.baseUrl}/api/clients/traffic/${encodeURIComponent(email)}`);
        return await response.json();
    }

    async getSettings() {
        const response = await fetch(`${this.baseUrl}/api/settings`);
        return await response.json();
    }

    async saveSettings(settings) {
        const response = await fetch(`${this.baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        return await response.json();
    }
}
