//! POC probe (openpycharm): does `queries/python/locals.scm` resolve the
//! bindings that Extract Method needs most — `with ... as`, `except ... as`,
//! `match/case`, plus a few neighbours? Prints instead of asserting, so the
//! real answer is visible even when it is "not covered".
//!
//! Delete together with its `mod` line once the POC records the answer.

use super::*;

fn report(src: &str, word: &str, nth: usize) -> String {
    let got = locals_at("python", src, word, nth);
    match &got {
        Locals::Local { symbol } => format!(
            "{word} #{nth}: Local  kind={:?} certain={} def={:?} refs={} conflict={}",
            symbol.kind,
            symbol.certain,
            symbol.definition,
            symbol.references.len(),
            symbol.conflicts.len()
        ),
        Locals::NotLocal { reason, .. } => format!("{word} #{nth}: NotLocal {reason:?}"),
        Locals::NoIdentifier => format!("{word} #{nth}: NoIdentifier"),
    }
}

#[test]
fn probe_python_bindings() {
    // 1. with ... as  (as_pattern / as_pattern_target?)
    let with = "def f(p):\n    with open(p) as fh:\n        data = fh.read()\n    return data\n";
    println!("\n--- with ... as ---\n{}", report(with, "fh", 1));

    // 2. except ... as  (as_pattern?)
    let exc = "def f():\n    try:\n        go()\n    except ValueError as e:\n        log(e)\n";
    println!("\n--- except ... as ---\n{}", report(exc, "e", 1));

    // 3. match / case bindings (Python 3.10+)
    let m = "def f(v):\n    match v:\n        case [a, b]:\n            return a + b\n    return None\n";
    println!("\n--- match/case ---\n{}\n{}", report(m, "a", 1), report(m, "b", 1));

    // 4. match case with a class pattern + guard
    let m2 = "def f(v):\n    match v:\n        case Point(x=px) if px > 0:\n            return px\n    return 0\n";
    println!("\n--- match class pattern ---\n{}", report(m2, "px", 1));

    // 5. walrus in a comprehension
    let w = "def f(xs):\n    return [y for x in xs if (y := g(x))]\n";
    println!("\n--- walrus ---\n{}", report(w, "y", 1));

    // 6. star-target in assignment
    let s = "def f(pair):\n    first, *rest = pair\n    return first, rest\n";
    println!("\n--- star target ---\n{}\n{}", report(s, "first", 1), report(s, "rest", 1));

    // 7. nested def with closure over a parameter
    let n = "def outer(p):\n    def inner():\n        return p\n    return inner\n";
    println!("\n--- closure over parameter ---\n{}", report(n, "p", 2));

    // 8. global / nonlocal declarations (Extract Method must refuse these)
    let g = "def f():\n    global gv\n    gv = 1\n    def inner():\n        nonlocal gv\n        gv = 2\n";
    println!("\n--- global/nonlocal ---\n{}", report(g, "gv", 2));

    // 9. for-loop target unpacking
    let fl = "def f(items):\n    for k, v in items:\n        use(k, v)\n";
    println!("\n--- for unpack ---\n{}\n{}", report(fl, "k", 1), report(fl, "v", 1));

    // 10. exception handler without `as`, and `except*` (3.11)
    let e2 = "def f():\n    try:\n        go()\n    except* ValueError:\n        pass\n";
    println!("\n--- except* (3.11) parse ---\n{}", report(e2, "ValueError", 1));
}
