import { beforeEach, describe, expect, it } from 'bun:test';

import {
  dismissTopDismissLayer,
  getDismissLayerCount,
  registerDismissLayer,
  subscribeDismissLayers,
} from './dismiss-layer';

describe('dismiss layer 栈', () => {
  beforeEach(() => {
    expect(getDismissLayerCount()).toBe(0);
  });

  it('空栈时 dismissTop 返回 false', () => {
    expect(getDismissLayerCount()).toBe(0);
    expect(dismissTopDismissLayer()).toBe(false);
  });

  it('注册后计数增加，注销后回落', () => {
    const unregister = registerDismissLayer(() => {});
    expect(getDismissLayerCount()).toBe(1);
    unregister();
    expect(getDismissLayerCount()).toBe(0);
  });

  it('dismissTop 按后进先出关闭最顶层', () => {
    const dismissed: string[] = [];
    const unregisterFirst = registerDismissLayer(() => dismissed.push('first'));
    const unregisterSecond = registerDismissLayer(() => dismissed.push('second'));

    expect(dismissTopDismissLayer()).toBe(true);
    expect(dismissed).toEqual(['second']);

    unregisterSecond();
    expect(dismissTopDismissLayer()).toBe(true);
    expect(dismissed).toEqual(['second', 'first']);

    unregisterFirst();
    expect(getDismissLayerCount()).toBe(0);
    expect(dismissTopDismissLayer()).toBe(false);
  });

  it('中间层提前注销后 dismissTop 仍命中真正的顶层', () => {
    const dismissed: string[] = [];
    const unregisterBottom = registerDismissLayer(() => dismissed.push('bottom'));
    const unregisterMiddle = registerDismissLayer(() => dismissed.push('middle'));
    const unregisterTop = registerDismissLayer(() => dismissed.push('top'));

    unregisterMiddle();
    expect(getDismissLayerCount()).toBe(2);

    expect(dismissTopDismissLayer()).toBe(true);
    expect(dismissed).toEqual(['top']);

    unregisterTop();
    unregisterBottom();
  });

  it('重复调用注销函数是幂等的', () => {
    const unregisterOuter = registerDismissLayer(() => {});
    const unregister = registerDismissLayer(() => {});

    unregister();
    unregister();
    unregister();

    expect(getDismissLayerCount()).toBe(1);
    unregisterOuter();
  });

  it('相同 dismiss 函数注册两次是两个独立层', () => {
    const dismissed: number[] = [];
    const dismiss = () => dismissed.push(1);

    const unregisterA = registerDismissLayer(dismiss);
    const unregisterB = registerDismissLayer(dismiss);
    expect(getDismissLayerCount()).toBe(2);

    unregisterA();
    expect(getDismissLayerCount()).toBe(1);

    expect(dismissTopDismissLayer()).toBe(true);
    expect(dismissed).toEqual([1]);

    unregisterB();
    expect(getDismissLayerCount()).toBe(0);
  });

  it('注册、注销与 dismiss 都会通知订阅者', () => {
    let notifications = 0;
    const unsubscribe = subscribeDismissLayers(() => {
      notifications += 1;
    });

    const unregister = registerDismissLayer(() => {});
    expect(notifications).toBe(1);

    expect(dismissTopDismissLayer()).toBe(true);
    expect(notifications).toBe(2);

    unregister();
    expect(notifications).toBe(3);

    unsubscribe();
    registerDismissLayer(() => {})();
    expect(notifications).toBe(3);
  });
});
