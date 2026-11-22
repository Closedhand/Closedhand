// Closedhand's additions to noVNC for the sandbox computer's screen
// (vnc_lite.html), kept apart from noVNC's own files.

// The server sends a frame when asked, and noVNC asks for the next one only
// once the last has arrived: one frame per round trip to the computer
// running Closedhand. Watched from a phone over the internet, that was 4 to 7
// frames a second while scrolling, 140 ms apart (2026-11-06). Asking ahead,
// two frames at most, lets it send each frame as soon as the screen changes.
// A frame that takes longer to arrive than frames come means the connection
// is what is slow, and asking ahead would only queue frames behind each
// other, so it asks ahead less, then not at all.
//
// Xvnc can send frames unasked instead (continuous updates), but it waits
// for each one's fence to come back before the next: one frame per round
// trip again. Over a 110 ms one that was 5 to 7 frames a second while
// scrolling, when the sandbox itself made 59; asked ahead, the same scroll
// came at 27 to 37 (2026-11-06). So neither is offered to it.
export const AHEAD_EVERY_MS = 33;
const FENCE = -312, CONTINUOUS_UPDATES = -313;

// A finger dragged on a phone: one scroll wheel step per SCROLL_STEP pixels
// it moves, at most MAX_STEPS at once, and a flick carries on for FLICK_MS.
export const SCROLL_STEP = 45, MAX_STEPS = 40, FLICK_MS = 250;

export function aheadFor(arrivalMs) {
    return arrivalMs > 120 ? 0 : arrivalMs > 40 ? 1 : 2;
}

// Base is noVNC's RFB; messages is RFB.messages; clock, visible and every
// stand in for the page's in the tests.
export function makeScreen(Base, messages, {
    clock = () => performance.now(),
    visible = () => !document.hidden,
    every = (fn, ms) => setInterval(fn, ms),
    coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
} = {}) {
    return class Screen extends Base {
        constructor(target, channel, options) {
            super(target, channel, options);
            this._ahead = 0;
            this._aheadMax = 2;
            this._arrival = 0;
            this._frameStart = null;
            // Told the screen's size (width, height, drawn) when it changes,
            // and again once a frame of that size is drawn.
            this.onScreenSize = null;
            this._sizeToTell = false;
            this._aheadTimer = every(() => this._askAhead(), AHEAD_EVERY_MS);
            // Told once the first frame is drawn (onFrame), where a tap
            // landed (onTap) and that a drag's scroll has ended (onScrolled).
            this.onFrame = null;
            this.onTap = null;
            this.onScrolled = null;
            this.dragScrolls = false;
            // A phone has no mouse: the stand-in pointer noVNC draws for a
            // touch screen (a grey dot) said otherwise.
            if (coarse() && this._cursor) { try { this._cursor.detach(); } catch (e) { /* none drawn */ } }
        }

        _askAhead() {
            if (this._rfbConnectionState === 'disconnected') { clearInterval(this._aheadTimer); return; }
            if (this._rfbConnectionState !== 'connected' || !visible() || this._ahead >= this._aheadMax) return;
            messages.fbUpdateRequest(this._sock, true, 0, 0, this._fbWidth, this._fbHeight);
            this._ahead++;
        }

        // noVNC's list without fences and continuous updates (above).
        _sendEncodings() {
            const send = messages.clientEncodings;
            messages.clientEncodings = (sock, encs) => send(sock, encs.filter((e) => e !== FENCE && e !== CONTINUOUS_UPDATES));
            try { super._sendEncodings(); } finally { messages.clientEncodings = send; }
        }

        _framebufferUpdate() {
            if (this._frameStart === null) this._frameStart = clock();
            const done = super._framebufferUpdate();
            if (!done) return false;
            const took = clock() - this._frameStart;
            this._frameStart = null;
            this._ahead = 0;
            this._arrival = this._arrival ? this._arrival * 0.7 + took * 0.3 : took;
            this._aheadMax = aheadFor(this._arrival);
            if (this._sizeToTell) {
                this._sizeToTell = false;
                if (this.onScreenSize) this.onScreenSize(this._fbWidth, this._fbHeight, true);
            }
            if (this.onFrame) { const told = this.onFrame; this.onFrame = null; told(); }
            return true;
        }

        // Full screen on a phone (vnc_lite.html sets dragScrolls), a finger
        // dragged scrolls the page under it by the scroll wheel, as a phone's
        // own browser does, and a flick carries on a little. As noVNC's drag
        // it was a held mouse button the page took for a finger, moved one
        // round trip to the computer at a time: laggy, and it looked as if
        // the mouse was meant. A tap says where it landed first (onTap, in
        // the screen's pixels), so a text box tapped can open the phone's
        // keyboard while the tap is still the person's own.
        _handleGesture(ev) {
            const d = ev.detail || {};
            if (ev.type === 'gesturestart' && d.type === 'onetap' && this.onTap) {
                const p = this._screenPoint(d.clientX, d.clientY);
                if (p) this.onTap(p.x, p.y);
            }
            if (!this.dragScrolls || d.type !== 'drag') return super._handleGesture(ev);
            const now = clock();
            if (ev.type === 'gesturestart') {
                this._dragY = d.clientY;
                this._dragLeft = 0;
                this._dragTrail = [[now, d.clientY]];
                this._dragAt = this._elementPoint(d.clientX, d.clientY);
                if (this._dragAt) this._handleMouseMove(this._dragAt.x, this._dragAt.y);
            } else if (ev.type === 'gesturemove') {
                this._dragLeft += this._dragY - d.clientY;
                this._dragY = d.clientY;
                this._dragTrail.push([now, d.clientY]);
                while (this._dragTrail.length > 6) this._dragTrail.shift();
                this._wheelSteps();
            } else if (ev.type === 'gestureend') {
                // A flick: the speed of the last moments, carried on for a
                // quarter of a second.
                const t = this._dragTrail || [], first = t[0], last = t[t.length - 1];
                const speed = first && last && last[0] > first[0] ? (first[1] - last[1]) / (last[0] - first[0]) : 0;
                if (Math.abs(speed) > 0.5) this._dragLeft += speed * FLICK_MS;
                this._wheelSteps();
                this._dragLeft = 0;
                if (this.onScrolled) this.onScrolled();
            }
        }

        // One scroll wheel step for every SCROLL_STEP pixels the finger went:
        // about what a step scrolls a page there, so the page keeps up with
        // the finger.
        _wheelSteps() {
            const at = this._dragAt;
            if (!at) return;
            for (let n = 0; n < MAX_STEPS && this._dragLeft >= SCROLL_STEP; n++) { this._wheel(at, 0x10); this._dragLeft -= SCROLL_STEP; }
            for (let n = 0; n < MAX_STEPS && this._dragLeft <= -SCROLL_STEP; n++) { this._wheel(at, 0x8); this._dragLeft += SCROLL_STEP; }
        }

        _wheel(at, bmask) {
            this._handleMouseButton(at.x, at.y, true, bmask);
            this._handleMouseButton(at.x, at.y, false, bmask);
        }

        _elementPoint(clientX, clientY) {
            const c = this._canvas;
            if (!c) return null;
            const b = c.getBoundingClientRect();
            return { x: Math.min(Math.max(clientX - b.left, 0), b.width - 1), y: Math.min(Math.max(clientY - b.top, 0), b.height - 1) };
        }

        _screenPoint(clientX, clientY) {
            const p = this._elementPoint(clientX, clientY);
            return p && this._display ? { x: this._display.absX(p.x), y: this._display.absY(p.y) } : null;
        }

        // A new size (the phone shape and back) is drawn whole. noVNC asks
        // only for what changes after it, so wherever a server sent nothing
        // the picture of the old shape stayed: half a phone-shaped page
        // beside the laptop-shaped one. Only a size that changed: a server
        // answers every whole-frame request with the size again, and asking
        // again on that sent whole frames for ever.
        _resize(width, height) {
            const changed = width !== this._fbWidth || height !== this._fbHeight;
            super._resize(width, height);
            if (!changed) return;
            this._sizeToTell = true;
            if (this.onScreenSize) this.onScreenSize(width, height, false);
            if (this._rfbConnectionState === 'connected') messages.fbUpdateRequest(this._sock, false, 0, 0, width, height);
        }
    };
}
