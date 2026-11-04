// SPDX-License-Identifier: GPL-2.0-or-later
// Makes the keyboard usable while a modal shell UI holds the input grab: polkit
// authentication, keyring prompts, network password dialogs, the unlock screen.
//
// Main.pushModal() grabs the input for the dialog actor. Clutter then delivers every
// pointer/touch event to the dialog only, even when the finger is on our keyboard.
// GNOME's own OSK lives in Main.layoutManager.keyboardBox, and the modal UIs forward
// events for it from their captured-event handlers via Main.keyboard.maybeHandleEvent()
// (ModalDialog, UnlockDialog, GrabHelper/popup menus, Looking Glass). We hook that
// method and re-dispatch events whose actor belongs to one of our chrome roots through
// the actor chain (captured phase root → leaf, then bubbling leaf → root), like Clutter
// would without the grab. Later events of a sequence that started on our UI follow it,
// even when the finger has left the keyboard, so swipe-down-to-hide works as well.
//
// Not covered: Clutter.Gesture based widgets (St.Button on GNOME 49+ in the settings
// panel); the gesture framework only sees events dispatched by the stage itself.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LOG_PREFIX = '[tablet-osk]';

function seqKey(event) {
    const seq = event.get_event_sequence?.();
    if (seq)
        return `t${seq.get_slot?.() ?? 0}`;
    return 'pointer';
}

/**
 * Delivers an event to `leaf` and its ancestors up to `root`, captured phase first.
 * Returns true if some handler stopped it.
 *
 * @param {Clutter.Actor} leaf
 * @param {Clutter.Actor} root
 * @param {Clutter.Event} event
 * @returns {boolean}
 */
export function dispatchThroughChain(leaf, root, event) {
    const chain = [];
    for (let a = leaf; a; a = a.get_parent()) {
        chain.push(a);
        if (a === root)
            break;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].event(event, true))
            return true;
    }
    for (const a of chain) {
        if (a.event(event, false))
            return true;
    }
    return false;
}

export class ModalBridge {
    constructor() {
        this._roots = new Set();
        this._handlers = new Set();
        this._seqs = new Map(); // seqKey -> {root, leaf} or {handler}
        this._km = null;
        this._orig = null;
        this._install();
    }

    /** An actor tree (chrome) whose events should reach it during modal grabs. */
    addRoot(actor) {
        this._roots.add(actor);
    }

    removeRoot(actor) {
        this._roots.delete(actor);
        for (const [k, st] of this._seqs) {
            if (st.root === actor)
                this._seqs.delete(k);
        }
    }

    /**
     * A fallback handler for events outside all roots (e.g. an edge swipe).
     * handler(event) returns true to claim the event; the rest of its sequence is
     * then given to the same handler.
     */
    addHandler(handler) {
        this._handlers.add(handler);
    }

    removeHandler(handler) {
        this._handlers.delete(handler);
        for (const [k, st] of this._seqs) {
            if (st.handler === handler)
                this._seqs.delete(k);
        }
    }

    /** Drop tracked sequences (e.g. when the keyboard is hidden). */
    reset() {
        this._seqs.clear();
    }

    _install() {
        const km = Main.keyboard;
        if (!km || typeof km.maybeHandleEvent !== 'function') {
            console.warn(`${LOG_PREFIX} Main.keyboard.maybeHandleEvent missing, modal bridge inactive`);
            return;
        }
        this._km = km;
        this._orig = Object.hasOwn(km, 'maybeHandleEvent') ? km.maybeHandleEvent : null;
        const bridge = this;
        const orig = km.maybeHandleEvent;
        km.maybeHandleEvent = function (event) {
            let handled = false;
            try {
                handled = bridge._handle(event);
            } catch (e) {
                console.error(`${LOG_PREFIX} modal bridge: ${e}`);
            }
            return handled || orig.call(this, event);
        };
    }

    _rootFor(actor) {
        if (!actor)
            return null;
        for (const root of this._roots) {
            if (root.mapped && root.contains(actor))
                return root;
        }
        return null;
    }

    _handle(event) {
        const T = Clutter.EventType;
        const type = event.type();
        const begins = type === T.BUTTON_PRESS || type === T.TOUCH_BEGIN;
        const ends = type === T.BUTTON_RELEASE || type === T.TOUCH_END ||
            type === T.TOUCH_CANCEL;
        const inSeq = begins || ends || type === T.MOTION || type === T.TOUCH_UPDATE;
        const key = inSeq ? seqKey(event) : null;

        if (begins)
            this._seqs.delete(key);

        let st = key ? this._seqs.get(key) : null;
        // A mouse press whose release we never saw (one of our own grabs took over):
        // plain hover motion must not stay captured.
        if (st && type === T.MOTION && key === 'pointer' &&
            !(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
            this._seqs.delete(key);
            st = null;
        }
        if (!st) {
            // Plain motion (hover) and scroll: deliver to whatever is under the pointer.
            if (!begins && type !== T.MOTION && type !== T.SCROLL)
                return false;
            const actor = global.stage.get_event_actor(event);
            const root = this._rootFor(actor);
            if (root) {
                const handled = dispatchThroughChain(actor, root, event);
                if (begins)
                    this._seqs.set(key, {root, leaf: actor});
                return handled || begins;
            }
            if (!begins)
                return false;
            for (const handler of this._handlers) {
                if (handler(event)) {
                    this._seqs.set(key, {handler});
                    return true;
                }
            }
            return false;
        }

        if (ends)
            this._seqs.delete(key);
        if (st.handler) {
            st.handler(event);
            return true;
        }
        // The leaf may have been destroyed or the keyboard rebuilt meanwhile.
        let leaf = st.root;
        try {
            if (st.root.contains(st.leaf))
                leaf = st.leaf;
        } catch {}
        dispatchThroughChain(leaf, st.root, event);
        return true;
    }

    destroy() {
        if (this._km) {
            if (this._orig)
                this._km.maybeHandleEvent = this._orig;
            else
                delete this._km.maybeHandleEvent;
        }
        this._km = null;
        this._orig = null;
        this._roots.clear();
        this._handlers.clear();
        this._seqs.clear();
    }
}
