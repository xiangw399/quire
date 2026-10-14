/**
 * The shell's slot service — the one service whose real contract was stricter
 * than it looked.
 *
 * `SlotCore` (the reader's own registry package) requires every slot to be
 * *declared* by a parent entry's `children` table before anything may register
 * into it, and it refuses a second declaration of the same key. DSH's chrome
 * declares the reader's seats: the reader's tab type registers into the right
 * Sidebar's seat and declares the document seats beneath it.
 *
 * A shell that owns no right Sidebar therefore has to seed those two seats and
 * cope with the reader declaring the document seats itself when its tab body
 * registers. Three facts from the registry drive the rules here:
 *
 *  - the `root` slot is seeded a-priori and is `single`, so exactly one seed
 *    entry may hang from it at a time;
 *  - disposing a parent entry collapses every child slot it declared, so seats
 *    the reader still needs must be re-seeded after a parent goes away;
 *  - a registration whose `children` table names an already-declared key throws
 *    before it takes effect, which is the signal that the registrant is taking
 *    ownership of that seat.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';

/** The parent seat the shell's detached declarations hang from. */
export const ROOT_SEAT = 'root';

/**
 * Read one slot occurrence: the winning entry plus its composed props.
 *
 * Entries are plain records rather than React elements so the caller can decide
 * what wraps them (a key, an error boundary, the pane's own chrome).
 *
 * @param service - the slot service.
 * @param name - slot key.
 * @param ownerProps - the owner's share of the composed props.
 * @param opts - `{ entryKey, only, hookContext }`; `hookContext` is the value a
 *               slot-level hook factory receives, exactly as the renderer passes
 *               it when it dispatches a nested slot.
 * @returns the entry, its component, and its props; `undefined` when the slot is empty.
 */
export function renderSlotOccurrence(service, name, ownerProps = {}, opts = {}) {
  const entries = service.core.entriesOfSlot(name);
  const entry = entries.find((candidate) => {
    const options = candidate.options;
    if (opts.entryKey !== undefined) return options.key === opts.entryKey;
    if (opts.only !== undefined) return options.id === opts.only;
    return true;
  });
  if (entry === undefined) return undefined;
  return {
    entry,
    Component: entry.component,
    props: service.composeProps(entry, ownerProps, { slotName: name, hookContext: opts.hookContext }),
  };
}

/** Wrap a plain observable source (or getSnapshot/subscribe pair) as a selector hook. */
export function selectorHookOf(source) {
  return function useSelector(selector, equal) {
    const last = useRef({ value: undefined, initialized: false });
    const read = useCallback(() => {
      const snapshot = source.getSnapshot();
      if (selector === undefined) return snapshot;
      const next = selector(snapshot);
      if (last.current.initialized) {
        const same = equal !== undefined ? equal(last.current.value, next) : Object.is(last.current.value, next);
        if (same) return last.current.value;
      }
      last.current = { value: next, initialized: true };
      return next;
    }, [selector, equal]);
    const subscribe = useCallback((listener) => source.subscribe(listener), []);
    return useSyncExternalStore(subscribe, read, read);
  };
}

/** Whether a value is the observable pair a slot component can subscribe to. */
export function isObservable(value) {
  return value !== null && typeof value === 'object' && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function';
}

/**
 * Bind one component-side hook from a slot-level inject compartment.
 *
 * The reader puts three different things under `hooks`, and each becomes a
 * different prop:
 *
 *  - an observable source (`{ getSnapshot, subscribe }`) — subscribed to, so the
 *    component re-renders with it (the reader's own renderer registry, file
 *    metadata);
 *  - a factory (`(standard, hookContext) => hook`) — called with the occurrence's
 *    context, and its result is the hook the component calls (the tab reader);
 *  - a plain value — handed over as-is (a feature switch such as the interactive
 *    HTML preview flag).
 *
 * @param source - the declared hook value.
 * @param standard - the standard props share, passed to a factory.
 * @param hookContext - the occurrence's opaque context, passed to a factory.
 * @returns the prop value for `use<Name>`.
 */
export function bindSlotHook(source, standard, hookContext) {
  if (isObservable(source)) return selectorHookOf(source);
  if (typeof source === 'function') {
    const bound = source(standard, hookContext);
    return typeof bound === 'function' ? bound : () => bound;
  }
  return () => source;
}

/** A source that never holds a value, for keyed hooks whose key is unknown. */
export const EMPTY_SOURCE = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
};

/**
 * Create the slot service.
 * @param options - the registry, the prop composer, and the seats to seed.
 */
export function createSlotService({ core, composeProps, seats }) {
  const seeds = new Map(seats.map((seat) => [seat.name, seat]));
  /** Slots the shell seeded as detached declarations. */
  let seeded = new Set();
  /** The single seed entry currently hanging from `root`. */
  let seedDisposer;
  /** Contributions dropped because this shell hosts no outlet for them. */
  const ignoredContributions = [];

  /**
   * Register a contribution that this shell may have no outlet for.
   *
   * A plugin can ship chrome of its own — the theme plugin contributes two settings
   * rows — and a shell without that chrome must ignore the contribution rather than
   * fail at boot. Such a contribution is acknowledged and dropped: no seat is
   * declared for it, nothing renders, and the plugin receives a disposer it can
   * call. Anything the registry refuses for a reason *other* than a missing or
   * occupied outlet still throws, so a real mistake stays visible.
   *
   * @param declaration - the registration options.
   * @param component - the component the plugin wanted to render.
   * @returns a disposer that does nothing.
   */
  function registerTolerant(declaration, component) {
    if (core.specDynamic(declaration.name) === undefined) {
      ignoredContributions.push(`${declaration.name}${declaration.id === undefined ? '' : ` [${declaration.id}]`}`);
      return () => {};
    }
    try {
      return register(declaration, component);
    } catch (error) {
      const message = String(error?.message ?? error);
      const outletless = message.includes('already has a registration') || message.includes('requires options.');
      if (!outletless) throw error;
      ignoredContributions.push(`${declaration.name}${declaration.id === undefined ? '' : ` [${declaration.id}]`}`);
      return () => {};
    }
  }

  /**
   * (Re)declare the seats the shell seeds through one entry hanging from `root`.
   *
   * `root` is a single slot, so exactly one seed entry may exist at a time. Every
   * seat the shell seeds is therefore carried by that one entry, and adding a seat
   * means retiring the entry and creating a replacement that declares them all:
   * disposing a parent collapses the seats it declared, so a partial rewrite would
   * drop the others.
   *
   * @param names - seat names to add; unknown names are ignored.
   */
  function seed(names) {
    const wanted = new Set(seeded);
    for (const name of names) {
      if (seeds.has(name)) wanted.add(name);
    }

    const children = {};
    for (const name of wanted) {
      if (core.specDynamic(name) !== undefined) continue;
      const seat = seeds.get(name);
      if (seat === undefined) continue;
      children[name] = { kind: seat.kind, scope: seat.scope ?? 'session' };
    }

    // Retire the current entry first: its cell must be free before the
    // replacement takes it, and the seats it declared are re-declared below.
    const previous = seedDisposer;
    previous?.();
    seedDisposer = undefined;
    seeded = new Set();

    if (Object.keys(children).length > 0) {
      seedDisposer = core.register({ name: ROOT_SEAT, children, priority: -1000 }, () => null);
      for (const name of Object.keys(children)) seeded.add(name);
    }
  }

  seed([...seeds.keys()]);

  /**
   * Register one component, coping with a child-declaration conflict.
   * @param declaration - the reader's registration options.
   * @param component - the component to render.
   */
  function register(declaration, component) {
    try {
      return core.register(declaration, component);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!message.includes('is already declared')) throw error;

      // The registrant declares keys the shell seeded: it is taking ownership.
      // Retire the seed entry, take the registration, and re-seed anything it
      // did not claim once it is disposed.
      const claimed = Object.keys(declaration.children ?? {});
      seedDisposer?.();
      seedDisposer = undefined;
      for (const key of claimed) seeded.delete(key);

      const dispose = core.register(declaration, component);
      return () => {
        dispose();
        seed(claimed);
      };
    }
  }

  return {
    core,
    register,
    registerTolerant,
    composeProps,
    seed,
    dispose() {
      seedDisposer?.();
      seedDisposer = undefined;
    },
    get seededSeats() {
      return [...seeded];
    },
    /** Contributions this shell acknowledged but has no outlet for. */
    get ignoredContributions() {
      return [...ignoredContributions];
    },
  };
}

// The seat names belong to DSH, so they come from the contract rather than being spelled
// here; re-exported because this module is where the slot service has always offered them.
export { READER_SEATS } from './contract.js';
