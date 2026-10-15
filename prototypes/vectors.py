"""Python prototype of kernel/src/math.rs.

Try maths out here first, then port it to Rust. Running this file checks the
Python version gives the same answers the Rust tests expect.
"""

import math

TOLERANCE = 1e-9


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def length(a):
    return math.sqrt(dot(a, a))


def approx_eq(a, b):
    return length(sub(a, b)) < TOLERANCE


if __name__ == "__main__":
    X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)
    assert add((1, 2, 3), (10, 20, 30)) == (11, 22, 33)
    assert approx_eq(cross(X, Y), Z)
    assert approx_eq(cross(Y, X), (0, 0, -1))
    a, b = (1, 2, 3), (4, -5, 6)
    c = cross(a, b)
    assert abs(dot(c, a)) < TOLERANCE and abs(dot(c, b)) < TOLERANCE
    # Same inputs as the default ones in the web app.
    print("A + B =", add((1, 2, 0), (2, -1, 1)))
    print("A x B =", cross((1, 2, 0), (2, -1, 1)))
    print("all checks passed")
