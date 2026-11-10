//! POC probe 2 (openpycharm): can the data-flow primitives Extract Method relies
//! on — `locals()` free variables + `references` — survive real Python code?
//!
//! Each case is a selection inside a realistic function. The probe prints what
//! the service says for every distinct name in the selection, so the harness
//! can be checked against the answer a human would give. Delete with the rest of
//! the POC.

use super::*;
use crate::Locals;

/// Every distinct identifier in `region`, with its `locals` verdict.
fn scan(src: &str, region: &str) -> Vec<String> {
    let base = src.find(region).unwrap_or_else(|| panic!("no region {region:?}"));
    let end = base + region.len();
    let mut seen: Vec<String> = Vec::new();
    let bytes = src.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = base;
    while i < end {
        if is_word(bytes[i]) && (i == 0 || !is_word(bytes[i - 1])) {
            let start = i;
            while i < end && is_word(bytes[i]) {
                i += 1;
            }
            let name = &src[start..i];
            if seen.iter().any(|s| s == name) {
                continue;
            }
            seen.push(name.to_owned());
            // The occurrence *inside the region*, not the first in the file.
            let nth = occurrences(src, name).iter().position(|&o| o >= start).map_or(1, |i| i + 1);
            let r = occ(src, name, nth);
            let verdict = match service().locals(&Snapshot::text(&lang("python"), src), r.start, &none()) {
                Ok(Locals::Local { symbol }) => {
                    let def = symbol.definition.start.line;
                    let refs: Vec<u32> = symbol.references.iter().map(|x| x.start.line).collect();
                    format!("local def@L{def} refs@L{refs:?} certain={}", symbol.certain)
                }
                Ok(Locals::NotLocal { reason, .. }) => format!("NOT-local {reason:?}"),
                Ok(Locals::NoIdentifier) => "no-identifier".to_owned(),
                Err(e) => format!("error {e:?}"),
            };
            println!("    {name:<20} {verdict}");
        } else {
            i += 1;
        }
    }
    seen
}

fn case(label: &str, src: &str, region: &str) {
    println!("\n--- {label} ---");
    scan(src, region);
}

#[test]
fn probe_real_python_dataflow() {
    // 1. The fixture's own `pending()`: a generator expression over `self`.
    let models = r#"class TaskList:
    def pending(self) -> list[Task]:
        # TODO: stable ordering for equal priorities (by due date)
        return sorted((t for t in self._tasks if not t.done), key=lambda t: -t.priority)
"#;
    case(
        "fixture: generator over self",
        models,
        "(t for t in self._tasks if not t.done)",
    );

    // 2. The fixture's `add()`: validates, builds, appends, returns.
    let add = r#"class TaskList:
    def add(self, title: str, priority: Priority = Priority.NORMAL, due: date | None = None, *tags: str) -> Task:
        if not title.strip():
            raise ValueError("title must not be empty")
        task = Task(title.strip(), priority, due, tags=set(tags))
        self._tasks.append(task)
        return task
"#;
    case(
        "fixture: build + append + return",
        add,
        "task = Task(title.strip(), priority, due, tags=set(tags))\n        self._tasks.append(task)",
    );

    // 3. Attribute writes: `self._tasks` is not a local, and writing it must not
    //    look like assigning a free variable.
    case(
        "fixture: attribute write",
        add,
        "self._tasks.append(task)",
    );

    // 4. A parameter written inside the selection (must be refused).
    let param = r#"def normalize(order):
    order = order.strip()
    return order.lower()
"#;
    case("parameter reassigned", param, "order = order.strip()");

    // 5. Method chained call + default argument referencing a parameter.
    let cli = r#"def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tasks")
    parser.add_argument("--overdue", action="store_true", help="only show overdue tasks")
    args = parser.parse_args(argv)
    return 0
"#;
    case(
        "fixture: parser chain",
        cli,
        "parser = argparse.ArgumentParser(prog=\"tasks\")\n    parser.add_argument(\"--overdue\", action=\"store_true\", help=\"only show overdue tasks\")\n    args = parser.parse_args(argv)",
    );

    // 6. f-string and comprehension inside the selection.
    let shown = r#"def show(tasks, today):
    for task in tasks:
        flag = "!" if task.priority is Priority.HIGH else " "
        print(f"{flag} {task.title} ({', '.join(sorted(task.tags))})")
    return None
"#;
    case(
        "f-string + nested comprehension",
        shown,
        "flag = \"!\" if task.priority is Priority.HIGH else \" \"\n        print(f\"{flag} {task.title} ({', '.join(sorted(task.tags))})\")",
    );

    // 7. Nested closure: the inner function reads and writes the outer name.
    let closure = r#"def outer(items):
    total = 0
    def bump(n):
        nonlocal total
        total += n
    for i in items:
        bump(i)
    return total
"#;
    case("closure with nonlocal", closure, "for i in items:\n        bump(i)");

    // 8. Tuple unpacking with a star target (the query does not cover it).
    let star = r#"def split(pair, rest):
    first, *tail = pair
    head, *tail = rest
    return first, head
"#;
    case("star target", star, "first, *tail = pair");

    // 9. Shadowing: the same name declared twice in nested blocks.
    let shadow = r#"def f(x):
    if x:
        y = 1
    else:
        y = 2
    return y
"#;
    case("branch-local shadow", shadow, "y = 1");

    // 10. Class attribute default that reads a module-level name.
    let attr = r#"class Task:
    def __init__(self, title, priority=Priority.NORMAL):
        self.title = title
        self.priority = priority
"#;
    case(
        "self attribute assignment",
        attr,
        "self.title = title\n        self.priority = priority",
    );

    // 11. except binding + logging (the as_pattern rule).
    let exc = r#"def parse(path):
    try:
        with open(path) as fh:
            raw = fh.read()
    except OSError as e:
        log(e)
        return None
    return raw
"#;
    case(
        "with + except as",
        exc,
        "with open(path) as fh:\n            raw = fh.read()",
    );

    // 12. Walrus in a comprehension inside the selection.
    let walrus = r#"def collect(rows):
    out = []
    for row in rows:
        if (n := len(row)) > 2:
            out.append(n)
    return out
"#;
    case("walrus", walrus, "if (n := len(row)) > 2:\n            out.append(n)");

    // 13. Annotated splat parameters (the rule added for the POC).
    let annot = r#"def f(a: int, *rest: int, **kw: str):
    return a, rest, kw
"#;
    case("annotated splats", annot, "return a, rest, kw");
}
