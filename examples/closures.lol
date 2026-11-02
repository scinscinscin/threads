let make_adder = function(n) {
  return function(x) {
    return x + n;
  };
};

let add_5 = make_adder(5);
print(add_5(10));

let add_100 = make_adder(100);
print(add_100(1));
