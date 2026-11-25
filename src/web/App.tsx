// The page: the sign-in in a browser, the shell around every section, and the router between them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Fragment, useEffect } from "react";
import { create_accounts_client, type Me } from "@x-tech-laboratories/x-libs/web/accounts";
import { AccountView, users_settings } from "@x-tech-laboratories/x-libs/web/react/accounts";
import { SyncCertificatePrompt } from "@x-tech-laboratories/x-libs/web/react/certificates";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Shell, use_route } from "@x-tech-laboratories/x-libs/web/react/shell";
import { SignInForm, use_account } from "@x-tech-laboratories/x-libs/web/react/sign_in";
import { Toasts } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { theme_choice } from "@x-tech-laboratories/x-libs/web/theme";

import { data_watch, page, use_data } from "./api.ts";
import { CommandsView } from "./commands/CommandsView.tsx";
import { DeviceDetail } from "./devices/DeviceView.tsx";
import { DevicesView } from "./devices/DevicesView.tsx";
import { HistoryView } from "./history/HistoryView.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { sidebar_pref, sidebar_sections, SidebarFoot } from "./Sidebar.tsx";

// ── Shell ────────────────────────────────────────────────────────────────────

const theme = theme_choice("x-control-theme");
const brand_icon = "icon.svg";

// Relative, so a server behind a proxy under a folder keeps it.
const accounts = create_accounts_client({ base: "api" });

const labels: Record<string, string> = { devices: "Devices", commands: "Commands", history: "History", settings: "Settings", account: "Your account" };

// ── App ──────────────────────────────────────────────────────────────────────

// A browser signs in to the server; the desktop app reaches its own daemon, and the phone signs in under Connections.
export function App() {
  return (
    <>
      {page().host === "web" ? <SignedInApp /> : <DeviceApp />}
      <Dialogs />
      <Toasts />
    </>
  );
}

function DeviceApp() {
  const { certificates, device } = page();
  return (
    <>
      {device && certificates && <SyncCertificatePrompt device={device} certificates={certificates} subscribe={data_watch.subscribe} />}
      <Pages me={null} />
    </>
  );
}

function SignedInApp() {
  const { account, refresh, sign_out } = use_account(accounts);
  if (account.state === "checking") return null;
  if (account.state === "signed_out") {
    return (
      <Shell brand="X-Control" brand_icon={brand_icon} theme={theme} user={null}>
        <SignInForm client={accounts} title="X-Control" icon={brand_icon} on_signed_in={refresh} />
      </Shell>
    );
  }
  return <Pages me={account.me} on_sign_out={() => void sign_out()} />;
}

function Pages({ me, on_sign_out }: { me: Me | null; on_sign_out?: () => void }) {
  const route = use_route();
  const [named = "devices", item] = route.parts;
  const section = named in labels && (named !== "account" || me) ? named : "devices";
  const devices = use_data((api) => api.list_devices());
  const view_key = route.parts.join("/");
  const is_admin = me !== null && me.role === me.roles.at(-1);
  const device_name = item ? devices.data?.find((device) => device.id === item)?.name : undefined;
  const label = device_name ?? labels[section]!;

  useEffect(() => {
    document.title = `${label} · X-Control`;
  }, [label]);

  const view = () => {
    if (section === "devices") return item ? <DeviceDetail id={item} /> : <DevicesView />;
    if (section === "commands") return <CommandsView />;
    if (section === "history") return <HistoryView />;
    if (section === "account" && me) return <AccountView client={accounts} />;
    return <SettingsView server_sections={me && is_admin ? users_settings({ client: accounts, me }) : []} />;
  };

  return (
    <Shell
      brand="X-Control"
      brand_icon={brand_icon}
      sections={sidebar_sections(devices.data ?? [])}
      active={section}
      active_item={item ?? null}
      sections_pref={sidebar_pref}
      sidebar_foot={<SidebarFoot />}
      theme={theme}
      view_key={view_key}
      user={me?.name}
      user_href="#/account"
      on_logout={on_sign_out}
      settings={{ href: "#/settings", active: section === "settings" }}
    >
      <Fragment key={view_key}>{view()}</Fragment>
    </Shell>
  );
}
