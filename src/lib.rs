use std::env;
use std::fs;

use zed_extension_api as zed;
use zed::serde_json::json;

const PACKAGE_NAME: &str = "@iconify/json";
const PACKAGE_CHECK_PATH: &str = "node_modules/@iconify/json/collections.json";
const SERVER_RELATIVE_PATH: &str = "language/server.js";
const SERVER_SCRIPT: &str = include_str!("../language/server.js");

struct IconifyIntellisense {
    did_install: bool,
    did_write_server: bool,
}

impl IconifyIntellisense {
    fn ensure_server_script(&mut self) -> zed::Result<String> {
        let workdir = env::current_dir().map_err(|error| format!("failed to resolve extension workdir: {error}"))?;
        let server_path = workdir.join(SERVER_RELATIVE_PATH);
        let server_dir = server_path.parent().ok_or_else(|| "failed to resolve server directory".to_string())?;
        if self.did_write_server && server_path.is_file() { return Ok(server_path.to_string_lossy().to_string()) }
        let mut needs_write = true; if let Ok(existing) = fs::read_to_string(&server_path) {
            if existing == SERVER_SCRIPT { needs_write = false }
        }
        if needs_write {
            fs::create_dir_all(server_dir).map_err(|error| format!("failed to create server directory: {error}"))?;
            fs::write(&server_path, SERVER_SCRIPT).map_err(|error| format!("failed to write {SERVER_RELATIVE_PATH}: {error}"))?;
        }
        self.did_write_server = true; Ok(server_path.to_string_lossy().to_string())
    }

    fn package_exists(&self) -> bool {
        fs::metadata(PACKAGE_CHECK_PATH).is_ok_and(|stat| stat.is_file())
    }

    fn ensure_iconify_json(&mut self, language_server_id: &zed::LanguageServerId ) -> zed::Result<()> {
        let package_exists = self.package_exists(); if self.did_install && package_exists {
            return Ok(());
        }
        zed::set_language_server_installation_status(language_server_id, &zed::LanguageServerInstallationStatus::CheckingForUpdate);
        let version = zed::npm_package_latest_version(PACKAGE_NAME)?;
        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;
        let needs_install = !package_exists || installed_version.as_ref() != Some(&version);
        if needs_install {
            zed::set_language_server_installation_status(language_server_id, &zed::LanguageServerInstallationStatus::Downloading);
            let result = zed::npm_install_package(PACKAGE_NAME, &version);
            match result {
                Ok(()) => { if !self.package_exists() { Err(format!("installed package '{PACKAGE_NAME}' did not contain expected path '{PACKAGE_CHECK_PATH}'"))? } }
                Err(error) => { if !self.package_exists() { Err(error)? } }
            }
        }
        self.did_install = true; Ok(())
    }
}

impl zed::Extension for IconifyIntellisense {
    fn new() -> Self { Self { did_install: false, did_write_server: false } }

    fn label_for_completion(&self, _language_server_id: &zed::LanguageServerId, completion: zed::lsp::Completion ) -> Option<zed::CodeLabel> {
        let label = completion.label;
        let pack = completion.detail.unwrap_or_default();
        let mut spans = Vec::with_capacity(if pack.is_empty() { 1 } else { 3 });
        spans.push(zed::CodeLabelSpan::Literal(zed::CodeLabelSpanLiteral { text: label.clone(), highlight_name: Some("comment".to_string()) }));
        if !pack.is_empty() {
            spans.push(zed::CodeLabelSpan::Literal(zed::CodeLabelSpanLiteral { text: " ".to_string(), highlight_name: None }));
            spans.push(zed::CodeLabelSpan::Literal(zed::CodeLabelSpanLiteral { text: pack, highlight_name: Some("comment".to_string()) }));
        }
        Some(zed::CodeLabel { code: label.clone(), spans, filter_range: zed::Range { start: 0, end: label.len() as u32 } })
    }

    fn language_server_command(&mut self, language_server_id: &zed::LanguageServerId, _worktree: &zed::Worktree) -> zed::Result<zed::Command> {
        let server_path = self.ensure_server_script()?;
        self.ensure_iconify_json(language_server_id)?;
        Ok(zed::Command { command: zed::node_binary_path()?, args: vec![server_path], env: Default::default() })
    }

    fn language_server_initialization_options(&mut self, _language_server_id: &zed::LanguageServerId, worktree: &zed::Worktree) -> zed::Result<Option<zed::serde_json::Value>> {
        let settings = zed::settings::LspSettings::for_worktree("iconify-intellisense", worktree)?;
        let icon_color = settings.settings.as_ref().and_then(|value| value.get("icon_color")).and_then(|value| value.as_str()).unwrap_or("#ffffff");
        Ok(Some(json!({ "iconColor": icon_color })))
    }
}

zed::register_extension!(IconifyIntellisense);
