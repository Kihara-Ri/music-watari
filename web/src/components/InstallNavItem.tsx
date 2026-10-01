// 侧栏与「更多」共用浏览器提供的安装入口。
export function InstallNavItem({evt, onInstalled}: {evt: Event; onInstalled: () => void}) {
  return <button type="button" className="install-nav" onClick={async () => {
    await (evt as Event & {prompt?: () => Promise<void>}).prompt?.();
    onInstalled();
  }}><span className="nav-ico" aria-hidden="true">⤓</span>安装碟渡</button>;
}
