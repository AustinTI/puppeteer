/**
 * @license
 * Copyright 2023 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {
  first,
  firstValueFrom,
  forkJoin,
  from,
  map,
  merge,
  raceWith,
} from '../../third_party/rxjs/rxjs.js';
import type {CDPSession} from '../api/CDPSession.js';
import type {ElementHandle} from '../api/ElementHandle.js';
import {
  Frame,
  throwIfDetached,
  type GoToOptions,
  type WaitForOptions,
} from '../api/Frame.js';
import type {WaitForSelectorOptions} from '../api/Page.js';
import {UnsupportedOperation} from '../common/Errors.js';
import type {TimeoutSettings} from '../common/TimeoutSettings.js';
import type {Awaitable, NodeFor} from '../common/types.js';
import {fromEmitterEvent, timeout, UTILITY_WORLD_NAME} from '../common/util.js';
import {Deferred} from '../util/Deferred.js';
import {disposeSymbol} from '../util/disposable.js';

import type {BrowsingContext} from './BrowsingContext.js';
import {ExposeableFunction} from './ExposedFunction.js';
import type {BidiHTTPResponse} from './HTTPResponse.js';
import {
  getBiDiLifecycleEvent,
  getBiDiReadinessState,
  rewriteNavigationError,
} from './lifecycle.js';
import type {BidiPage} from './Page.js';
import {
  MAIN_SANDBOX,
  PUPPETEER_SANDBOX,
  Sandbox,
  type SandboxChart,
} from './Sandbox.js';

/**
 * Puppeteer's Frame class could be viewed as a BiDi BrowsingContext implementation
 * @internal
 */
export class BidiFrame extends Frame {
  #page: BidiPage;
  #context: BrowsingContext;
  #timeoutSettings: TimeoutSettings;
  #abortDeferred = Deferred.create<never>();
  #disposed = false;
  sandboxes: SandboxChart;
  override _id: string;

  constructor(
    page: BidiPage,
    context: BrowsingContext,
    timeoutSettings: TimeoutSettings,
    parentId?: string | null
  ) {
    super();
    this.#page = page;
    this.#context = context;
    this.#timeoutSettings = timeoutSettings;
    this._id = this.#context.id;
    this._parentId = parentId ?? undefined;

    this.sandboxes = {
      [MAIN_SANDBOX]: new Sandbox(undefined, this, context, timeoutSettings),
      [PUPPETEER_SANDBOX]: new Sandbox(
        UTILITY_WORLD_NAME,
        this,
        context.createRealmForSandbox(),
        timeoutSettings
      ),
    };
  }

  override get client(): CDPSession {
    return this.context().cdpSession;
  }

  override mainRealm(): Sandbox {
    return this.sandboxes[MAIN_SANDBOX];
  }

  override isolatedRealm(): Sandbox {
    return this.sandboxes[PUPPETEER_SANDBOX];
  }

  override page(): BidiPage {
    return this.#page;
  }

  override isOOPFrame(): never {
    throw new UnsupportedOperation();
  }

  override url(): string {
    return this.#context.url;
  }

  override parentFrame(): BidiFrame | null {
    return this.#page.frame(this._parentId ?? '');
  }

  override childFrames(): BidiFrame[] {
    return this.#page.childFrames(this.#context.id);
  }

  @throwIfDetached
  override async goto(
    url: string,
    options: GoToOptions = {}
  ): Promise<BidiHTTPResponse | null> {
    const {
      waitUntil = 'load',
      timeout: ms = this.#timeoutSettings.navigationTimeout(),
    } = options;

    const [readiness, networkIdle] = getBiDiReadinessState(waitUntil);

    const response = await firstValueFrom(
      this.#page
        ._waitWithNetworkIdle(
          this.#context.connection.send('browsingContext.navigate', {
            context: this.#context.id,
            url,
            wait: readiness,
          }),
          networkIdle
        )
        .pipe(raceWith(timeout(ms), from(this.#abortDeferred.valueOrThrow())))
        .pipe(rewriteNavigationError(url, ms))
    );

    return this.#page.getNavigationResponse(response?.result.navigation);
  }

  @throwIfDetached
  override async setContent(
    html: string,
    options: WaitForOptions = {}
  ): Promise<void> {
    const {
      waitUntil = 'load',
      timeout: ms = this.#timeoutSettings.navigationTimeout(),
    } = options;

    const [waitEvent, networkIdle] = getBiDiLifecycleEvent(waitUntil);

    await firstValueFrom(
      this.#page
        ._waitWithNetworkIdle(
          forkJoin([
            fromEmitterEvent(this.#context, waitEvent).pipe(first()),
            from(this.setFrameContent(html)),
          ]).pipe(
            map(() => {
              return null;
            })
          ),
          networkIdle
        )
        .pipe(raceWith(timeout(ms), from(this.#abortDeferred.valueOrThrow())))
        .pipe(rewriteNavigationError('setContent', ms))
    );
  }

  context(): BrowsingContext {
    return this.#context;
  }

  @throwIfDetached
  override async waitForNavigation(
    options: WaitForOptions = {}
  ): Promise<BidiHTTPResponse | null> {
    const {
      waitUntil = 'load',
      timeout: ms = this.#timeoutSettings.navigationTimeout(),
    } = options;

    const [waitUntilEvent, networkIdle] = getBiDiLifecycleEvent(waitUntil);

    const navigatedObservable = merge(
      forkJoin([
        fromEmitterEvent(
          this.#context,
          Bidi.ChromiumBidi.BrowsingContext.EventNames.NavigationStarted
        ).pipe(first()),
        fromEmitterEvent(this.#context, waitUntilEvent).pipe(first()),
      ]),
      fromEmitterEvent(
        this.#context,
        Bidi.ChromiumBidi.BrowsingContext.EventNames.FragmentNavigated
      )
    ).pipe(
      map(result => {
        if (Array.isArray(result)) {
          return {result: result[1]};
        }
        return {result};
      })
    );

    const response = await firstValueFrom(
      this.#page
        ._waitWithNetworkIdle(navigatedObservable, networkIdle)
        .pipe(raceWith(timeout(ms), from(this.#abortDeferred.valueOrThrow())))
    );

    return this.#page.getNavigationResponse(response?.result.navigation);
  }

  override waitForDevicePrompt(): never {
    throw new UnsupportedOperation();
  }

  override get detached(): boolean {
    return this.#disposed;
  }

  [disposeSymbol](): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#abortDeferred.reject(new Error('Frame detached'));
    this.#context.dispose();
    this.sandboxes[MAIN_SANDBOX][disposeSymbol]();
    this.sandboxes[PUPPETEER_SANDBOX][disposeSymbol]();
  }

  #exposedFunctions = new Map<string, ExposeableFunction<never[], unknown>>();
  async exposeFunction<Args extends unknown[], Ret>(
    name: string,
    apply: (...args: Args) => Awaitable<Ret>
  ): Promise<void> {
    if (this.#exposedFunctions.has(name)) {
      throw new Error(
        `Failed to add page binding with name ${name}: globalThis['${name}'] already exists!`
      );
    }
    const exposeable = new ExposeableFunction(this, name, apply);
    this.#exposedFunctions.set(name, exposeable);
    try {
      await exposeable.expose();
    } catch (error) {
      this.#exposedFunctions.delete(name);
      throw error;
    }
  }

  override waitForSelector<Selector extends string>(
    selector: Selector,
    options?: WaitForSelectorOptions
  ): Promise<ElementHandle<NodeFor<Selector>> | null> {
    if (selector.startsWith('aria')) {
      throw new UnsupportedOperation(
        'ARIA selector is not supported for BiDi!'
      );
    }

    return super.waitForSelector(selector, options);
  }
}
