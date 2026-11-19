export type Greeting = { message: string };

export function greet(name = "world"): Greeting {
  return { message: `Hello, ${name}!` };
}

export * from "./storage";
