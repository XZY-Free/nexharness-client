/**
 * WebContentsView bounds 校验器。
 *
 * Main process 收到 renderer 传来的 bounds 后，必须校验：
 * - 数值是有限数（NaN/Infinity 拒绝）
 * - x/y 非负（不能超出窗口左上角）
 * - width/height 正数（最小 1px）
 * - 不超过窗口最大尺寸（防止覆盖工具栏）
 * - scaleFactor 正数
 *
 * 校验通过后返回 sanitized bounds，否则返回 null。
 */

/** Bounds 数据（DIP，device-independent pixels） */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 窗口尺寸约束 */
export interface WindowConstraints {
  /** 窗口内容区总宽度 */
  windowWidth: number;
  /** 窗口内容区总高度 */
  windowHeight: number;
}

/** 校验结果 */
export interface BoundsValidationResult {
  ok: boolean;
  bounds?: Bounds;
  error?: string;
}

/** 最小允许尺寸 */
export const MIN_BOUNDS_SIZE = 1;

/**
 * 校验 bounds 数值是否合法。
 *
 * @param bounds - renderer 传来的 bounds
 * @param constraints - 窗口尺寸约束
 * @param scaleFactor - 屏幕缩放因子（Retina 为 2，普通为 1）
 * @returns 校验通过返回 sanitized bounds，否则返回 error
 */
export function validateBounds(
  bounds: unknown,
  constraints: WindowConstraints,
  scaleFactor: number,
): BoundsValidationResult {
  // 校验 scaleFactor
  if (typeof scaleFactor !== "number" || !Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    return { ok: false, error: "scaleFactor 必须是正数" };
  }

  // 校验 bounds 是对象
  if (typeof bounds !== "object" || bounds === null) {
    return { ok: false, error: "bounds 必须是对象" };
  }

  const b = bounds as Record<string, unknown>;
  const { x, y, width, height } = b;

  // 校验所有字段是有限数
  if (typeof x !== "number" || !Number.isFinite(x)) {
    return { ok: false, error: "x 必须是有限数" };
  }
  if (typeof y !== "number" || !Number.isFinite(y)) {
    return { ok: false, error: "y 必须是有限数" };
  }
  if (typeof width !== "number" || !Number.isFinite(width)) {
    return { ok: false, error: "width 必须是有限数" };
  }
  if (typeof height !== "number" || !Number.isFinite(height)) {
    return { ok: false, error: "height 必须是有限数" };
  }

  // 校验 x/y 非负
  if (x < 0) {
    return { ok: false, error: "x 不能为负数" };
  }
  if (y < 0) {
    return { ok: false, error: "y 不能为负数" };
  }

  // 校验 width/height 正数
  if (width < MIN_BOUNDS_SIZE) {
    return { ok: false, error: `width 必须不小于 ${MIN_BOUNDS_SIZE}` };
  }
  if (height < MIN_BOUNDS_SIZE) {
    return { ok: false, error: `height 必须不小于 ${MIN_BOUNDS_SIZE}` };
  }

  // 校验不超出窗口
  if (x + width > constraints.windowWidth) {
    return { ok: false, error: "bounds 超出窗口右边界" };
  }
  if (y + height > constraints.windowHeight) {
    return { ok: false, error: "bounds 超出窗口下边界" };
  }

  // Sanitize：取整（防止浮点精度问题）
  return {
    ok: true,
    bounds: {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    },
  };
}

/**
 * 判断两个 bounds 是否有实际差异（忽略亚像素差异）。
 * 用于减少不必要的 setBounds 调用。
 *
 * @param a - 之前的 bounds
 * @param b - 新的 bounds
 * @returns 差异超过 1px 返回 true
 */
export function boundsChanged(a: Bounds, b: Bounds): boolean {
  return (
    Math.abs(a.x - b.x) >= 1 ||
    Math.abs(a.y - b.y) >= 1 ||
    Math.abs(a.width - b.width) >= 1 ||
    Math.abs(a.height - b.height) >= 1
  );
}

/**
 * 计算隐藏 bounds（将 View 移出可见区域）。
 * 不使用 width=0/height=0（某些 Chromium 版本会崩溃）。
 * 使用 1x1 位于 (0,0) 的最小 bounds。
 */
export function hiddenBounds(): Bounds {
  return { x: 0, y: 0, width: 1, height: 1 };
}

// ─── 视图显现的边界决策（从 browser-controller 抽出）────────────────

/** 首次显示时使用的默认可见 bounds（与 controller 常量一致）。 */
export const DEFAULT_VISIBLE_BOUNDS: Bounds = { x: 0, y: 80, width: 1400, height: 820 };

/** 激活切换时的边界决策。 */
export interface ActivationBounds {
  /** 旧 active view 应设为的 bounds（无旧 active 时为 null）。 */
  readonly hideBounds: Bounds | null;
  /** 新 active view 应设为的 bounds（无新 view 时为 null）。 */
  readonly showBounds: Bounds | null;
}

/**
 * 决定激活切换时新旧 view 各应设为的 bounds。
 *
 * 规则（与原 showView 一致）：
 * - 旧 active → 隐藏到 1x1（`hiddenBounds()`，不用 0x0 避免某些 Chromium 崩溃）
 * - 新 active → 用**上次记录的 bounds**；无记录则用默认可见 bounds
 *   （保证切换回来时布局与离开前一致，而不是突然跳成默认值）
 */
export function decideActivationBounds(params: {
  readonly hasHideTarget: boolean;
  readonly hasShowTarget: boolean;
  readonly lastBounds: Bounds | null | undefined;
}): ActivationBounds {
  return {
    hideBounds: params.hasHideTarget ? hiddenBounds() : null,
    showBounds: params.hasShowTarget ? (params.lastBounds ?? DEFAULT_VISIBLE_BOUNDS) : null,
  };
}
