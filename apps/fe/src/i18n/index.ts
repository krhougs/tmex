import { DEFAULT_LOCALE, type LocaleCode } from '@tmex/shared';
import i18n from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';

// 各语言翻译按需动态加载：每个 locale 拆成独立 chunk，首屏只加载当前语言，
// 不再把全部语言静态打进入口 bundle（原先静态 import I18N_RESOURCES 把 3 种语言全打进首屏）。
// 资源直接复用 packages/shared 的 locale JSON——生成器与网关侧的聚合 I18N_RESOURCES 都不受影响。
type LocaleModule = { default: { translation: Record<string, unknown> } };
const localeModules = import.meta.glob<LocaleModule>([
  '../../../../packages/shared/src/i18n/locales/*.json',
  '!../../../../packages/shared/src/i18n/locales/manifest.json',
]);

function loaderFor(lng: string): (() => Promise<LocaleModule>) | undefined {
  const entry = Object.entries(localeModules).find(([p]) => p.endsWith(`/${lng}.json`));
  return entry?.[1];
}

// Detect browser language
function detectBrowserLocale(): LocaleCode {
  const browserLang = navigator.language;
  if (browserLang.startsWith('zh')) return 'zh_CN';
  if (browserLang.startsWith('ja')) return 'ja_JP';
  return DEFAULT_LOCALE;
}

// init 是异步的（要拉取当前语言 chunk）；main.tsx 在首次渲染前 await 此 promise 以避免未翻译闪烁。
export const i18nReady = i18n
  .use(
    resourcesToBackend(async (lng: string, ns: string) => {
      const load = loaderFor(lng);
      if (!load) return {};
      const mod = await load();
      // locale JSON 顶层是 { translation: {...} }，返回对应 namespace 的内容。
      return (mod.default as Record<string, unknown>)[ns] ?? {};
    })
  )
  .use(initReactI18next)
  .init({
    lng: detectBrowserLocale(),
    fallbackLng: DEFAULT_LOCALE,
    ns: ['translation'],
    defaultNS: 'translation',
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
    react: {
      // 改异步加载后不走 Suspense：main.tsx 渲染前已 await i18nReady；运行时切语言由 react-i18next 监听事件重渲染。
      useSuspense: false,
    },
  });

export default i18n;
