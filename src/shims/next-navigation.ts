import { useMemo } from "react";
import {
  useLocation,
  useNavigate,
  useParams as useRouterParams,
  useSearchParams as useRouterSearchParams,
} from "react-router-dom";

/**
 * next/navigation → react-router 兼容 shim。
 *
 * 由 vite.resolve.alias 与 tsconfig paths 双解析（搬迁面零改源）。
 * - useRouter().refresh()：SPA 无 RSC 重渲染概念 → 整页 reload（等价"重新拉取"）。
 * - redirect()/notFound()：以异常终止渲染，由路由级 errorElement 兜底；
 *   页面内更细的 404 请直接渲染 NotFoundView。
 */

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, { replace: true }),
      back: () => navigate(-1),
      forward: () => navigate(1),
      refresh: () => window.location.reload(),
    }),
    [navigate],
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function useParams<T extends Record<string, string | undefined>>(): T {
  return useRouterParams() as T;
}

export function useSearchParams(): URLSearchParams {
  const [params] = useRouterSearchParams();
  return params;
}

export function redirect(href: string): never {
  window.location.replace(href);
  throw new Error("NEXT_REDIRECT");
}

export function notFound(): never {
  throw new Error("NEXT_NOT_FOUND");
}
