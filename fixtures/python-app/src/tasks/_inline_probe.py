def reassigned():
    x = 1
    x = 2
    return x


def impure_twice(items):
    rows = load(items)
    a = rows[0]
    return rows, a


def tuple_target(pair):
    first, second = pair
    return first


def shadowed(a):
    b = a + 1
    return b


def dependency():
    a = 1
    b = a + 1
    a = 5
    return b
