; From nvim-treesitter queries/python/locals.scm (Apache-2.0)

; Program structure
(module) @local.scope

(class_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @local.definition.field)))) @local.scope

(class_definition
  body: (block
    (expression_statement
      (assignment
        left: (_
          (identifier) @local.definition.field))))) @local.scope

; Imports
(aliased_import
  alias: (identifier) @local.definition.import) @local.scope

(import_statement
  name: (dotted_name
    (identifier) @local.definition.import)) @local.scope

(import_from_statement
  name: (dotted_name
    (identifier) @local.definition.import)) @local.scope

; Function with parameters, defines parameters
(parameters
  (identifier) @local.definition.parameter)

(default_parameter
  (identifier) @local.definition.parameter)

(typed_parameter
  (identifier) @local.definition.parameter)

(typed_default_parameter
  (identifier) @local.definition.parameter)

; *args parameter
(parameters
  (list_splat_pattern
    (identifier) @local.definition.parameter))

; **kwargs parameter
(parameters
  (dictionary_splat_pattern
    (identifier) @local.definition.parameter))

; Annotated splats: `*args: int`, `**kwargs: str`. The annotation wraps the
; splat in a `typed_parameter`, so the two rules above do not match.
(typed_parameter
  (list_splat_pattern
    (identifier) @local.definition.parameter))

(typed_parameter
  (dictionary_splat_pattern
    (identifier) @local.definition.parameter))

; Function defines function and scope
((function_definition
  name: (identifier) @local.definition.function) @local.scope
  (#set! definition.function.scope "parent"))

((class_definition
  name: (identifier) @local.definition.type) @local.scope
  (#set! definition.type.scope "parent"))

(class_definition
  body: (block
    (function_definition
      name: (identifier) @local.definition.method)))

; Loops
; not a scope!
(for_statement
  left: (pattern_list
    (identifier) @local.definition.var))

(for_statement
  left: (tuple_pattern
    (identifier) @local.definition.var))

(for_statement
  left: (identifier) @local.definition.var)

; not a scope!
;(while_statement) @local.scope
; for in list comprehension
(for_in_clause
  left: (identifier) @local.definition.var)

(for_in_clause
  left: (tuple_pattern
    (identifier) @local.definition.var))

(for_in_clause
  left: (pattern_list
    (identifier) @local.definition.var))

(dictionary_comprehension) @local.scope

(list_comprehension) @local.scope

(set_comprehension) @local.scope

; Assignments
(assignment
  left: (identifier) @local.definition.var)

(assignment
  left: (pattern_list
    (identifier) @local.definition.var))

(assignment
  left: (tuple_pattern
    (identifier) @local.definition.var))

(assignment
  left: (attribute
    (identifier)
    (identifier) @local.definition.field))

; Walrus operator  x := 1
(named_expression
  (identifier) @local.definition.var)

(as_pattern
  alias: (as_pattern_target) @local.definition.var)

; `match` capture patterns bind a name, exactly like an assignment does.
;
; The grammar wraps every binding in a `dotted_name`, which is what separates it
; from the parts that are values: in `case Point(x=px)` the class `Point` sits in
; a `class_pattern` and the field name `x` in a `keyword_pattern` without a
; `dotted_name`, while the binding `px` has one. Measured, not guessed:
;
;   case [a, b]        a  -> identifier < dotted_name < case_pattern
;   case {"k": v}      v  -> identifier < dotted_name < case_pattern
;   case x if ...      x  -> identifier < dotted_name < case_pattern
;   case Point(a, b)   a  -> identifier < dotted_name < case_pattern < class_pattern
;   case Point(x=px)   px -> identifier < dotted_name < keyword_pattern
;   case [a, *rest]    rest -> identifier < splat_pattern < case_pattern
;   --- not bindings ---
;   case Point(...)    Point -> identifier < dotted_name < class_pattern
;   case Point(x=..)   x     -> identifier < keyword_pattern
(case_pattern
  (dotted_name
    (identifier) @local.definition.var))

; `case Point(x=px)`: the binding is the keyword's value, not its name.
(keyword_pattern
  (dotted_name
    (identifier) @local.definition.var))

; `case [first, *rest]`.
(case_pattern
  (splat_pattern
    (identifier) @local.definition.var))

; REFERENCES
(identifier) @local.reference
