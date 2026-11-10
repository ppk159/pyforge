def summarize(items, rate):
    total = sum(items)
    scaled = total * rate
    label = f"{scaled:.2f}"
    return label


def pair_up(rows):
    first = rows[0]
    second = rows[1]
    return first, second
