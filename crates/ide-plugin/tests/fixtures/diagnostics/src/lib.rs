use pyforge_plugin::diagnostics::{DiagnosticsProvider, Document};
use pyforge_plugin::{Diagnostic, Error, Invocation, Plugin, Range, Severity, host, register_plugin, text};
use std::time::Duration;

#[derive(Default)]
struct Fixture {
    calls: u64,
}

impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "wait" => {
                host::set_context("fixture-gate", "wait").unwrap();
                std::thread::sleep(Duration::from_millis(400));
                Ok(Some("finished".into()))
            }
            "calls" => Ok(Some(self.calls.to_string())),
            "publish" => host::publish_diagnostics(
                arg.unwrap_or_default(),
                &[Diagnostic::new(Range::default(), Severity::Info, "Manual problem")],
            )
            .map(|()| None),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

impl DiagnosticsProvider for Fixture {
    fn diagnostics(&mut self, doc: &Document) -> Vec<Diagnostic> {
        self.calls += 1;
        if doc.text.starts_with("gate") {
            host::set_context("fixture-gate", self.calls.to_string()).unwrap();
        }
        if doc.text == "limits" {
            let mut diagnostic = Diagnostic::new(Range::default(), Severity::Hint, "m".repeat(5000));
            diagnostic.source = Some("s".repeat(200));
            diagnostic.code = Some("c".repeat(200));
            diagnostic.unnecessary = true;
            diagnostic.deprecated = true;
            return vec![diagnostic; 5001];
        }
        if doc.text.starts_with("slow") {
            std::thread::sleep(Duration::from_millis(200));
        }
        if doc.text.starts_with("spin") || doc.text.starts_with("gate spin") {
            loop {
                std::hint::spin_loop();
            }
        }
        if doc.text.starts_with("panic") {
            panic!("diagnostics fixture failed");
        }
        doc.text
            .match_indices("BAD")
            .map(|(offset, _)| {
                Diagnostic::new(
                    Range { start: text::position(&doc.text, offset), end: text::position(&doc.text, offset + 3) },
                    Severity::Warning,
                    format!("BAD in {} at version {}", doc.language, doc.version),
                )
                .code("bad-word")
            })
            .collect()
    }
}

impl pyforge_plugin::hover::HoverProvider for Fixture {
    fn hover(&mut self, _: &Document, _: pyforge_plugin::Position) -> Option<pyforge_plugin::hover::Hover> {
        None
    }
}

impl pyforge_plugin::inlay_hints::InlayHints for Fixture {
    fn inlay_hints(&mut self, _: &Document, _: Range) -> Vec<pyforge_plugin::inlay_hints::InlayHint> {
        Vec::new()
    }
}

impl pyforge_plugin::providers::Providers for Fixture {}

impl pyforge_plugin::endpoints::EndpointsProvider for Fixture {
    fn endpoints(&mut self, _: &Invocation) -> Result<Vec<pyforge_plugin::endpoints::Endpoint>, Error> {
        Ok(Vec::new())
    }
}

impl pyforge_plugin::views::Views for Fixture {
    fn render(
        &mut self,
        _: &str,
        _: Option<pyforge_plugin::views::Viewport>,
        _: &Invocation,
    ) -> Result<pyforge_plugin::views::View, Error> {
        Ok(pyforge_plugin::views::View::message(""))
    }
}

impl pyforge_plugin::indexing::DocumentIndexer for Fixture {
    fn index(&mut self, _: &pyforge_plugin::indexing::Document) -> pyforge_plugin::indexing::Edges {
        pyforge_plugin::indexing::Edges::default()
    }
}

impl pyforge_plugin::syntax::SyntaxProvider for Fixture {
    fn highlights(&mut self, _: &str, _: &str) -> Vec<pyforge_plugin::syntax::Token> {
        Vec::new()
    }
}

impl pyforge_plugin::semantic_tokens::SemanticTokens for Fixture {
    fn semantic_tokens(&mut self, _: &Document) -> Vec<pyforge_plugin::semantic_tokens::SemanticToken> {
        Vec::new()
    }
}

impl pyforge_plugin::details::Details for Fixture {
    fn detail(&mut self, _: &str, _: &str, _: &Invocation) -> Result<Vec<pyforge_plugin::details::Tab>, Error> {
        Ok(Vec::new())
    }
}

impl pyforge_plugin::commit::CommitChecks for Fixture {
    fn check(
        &mut self,
        _: &str,
        _: &pyforge_plugin::CommitDraft,
        _: &Invocation,
    ) -> Result<Vec<pyforge_plugin::commit::CommitProblem>, Error> {
        Ok(Vec::new())
    }
}

impl pyforge_plugin::file_actions::FileActions for Fixture {
    fn file_actions(&mut self, _: &Document, _: Range) -> Vec<pyforge_plugin::file_actions::FileAction> {
        Vec::new()
    }
}

#[cfg(feature = "diagnostics-first")]
register_plugin!(
    Fixture,
    diagnostics,
    endpoints,
    views,
    indexing,
    syntax,
    semantic_tokens,
    hover,
    providers,
    inlay_hints,
    details,
    commit_checks,
    file_actions
);
#[cfg(all(feature = "diagnostics-last", not(feature = "diagnostics-first")))]
register_plugin!(
    Fixture,
    file_actions,
    commit_checks,
    details,
    inlay_hints,
    providers,
    hover,
    semantic_tokens,
    syntax,
    indexing,
    views,
    endpoints,
    diagnostics
);
#[cfg(not(any(feature = "diagnostics-first", feature = "diagnostics-last")))]
register_plugin!(Fixture, diagnostics);
