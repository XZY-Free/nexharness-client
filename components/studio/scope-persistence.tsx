import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

/**
 * S1（12-P2-5）：analytics scope 持久化到 localStorage。
 * 挂载在 studio 总览页：无 query param scope 时读 localStorage 补全。
 */
export function ScopePersistence() {
  const navigate = useNavigate();
  // react-router 的 useSearchParams 返回 [params, setParams] 元组（与 next/navigation 不同）
  const [sp] = useSearchParams();
  useEffect(() => {
    const urlScope = sp.get("scope");
    if (!urlScope) {
      const saved = localStorage.getItem("nex-analytics-scope");
      if (saved === "global" || saved === "self") {
        navigate(`/studio?scope=${saved}`, { replace: true });
      }
    } else {
      localStorage.setItem("nex-analytics-scope", urlScope);
    }
  }, [sp, navigate]);
  return null;
}
