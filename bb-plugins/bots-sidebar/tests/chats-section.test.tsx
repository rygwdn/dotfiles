// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChatsSection } from "../components/chats-section";

beforeEach(() => localStorage.clear());
afterEach(cleanup);
const content = <div>A chat</div>;

it("collapses to the header, persists the choice, and restores it", () => {
  const onNewChat = vi.fn();
  const view = render(<ChatsSection activeChatId={null} onNewChat={onNewChat}>{content}</ChatsSection>);
  expect(view.getByText("A chat")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Chats" }));
  expect(view.getByRole("button", { name: "Chats" }).getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByText("A chat")).toBeNull();
  view.unmount();
  const again = render(<ChatsSection activeChatId={null} onNewChat={onNewChat}>{content}</ChatsSection>);
  expect(again.queryByText("A chat")).toBeNull();
  fireEvent.click(again.getByRole("button", { name: "Chats" }));
  expect(again.getByText("A chat")).toBeTruthy();
});

it("reopens on navigation to another chat but allows deliberate collapse of the current one", () => {
  const view = render(<ChatsSection activeChatId="one" onNewChat={() => {}}>{content}</ChatsSection>);
  fireEvent.click(view.getByRole("button", { name: "Chats" }));
  view.rerender(<ChatsSection activeChatId="one" onNewChat={() => {}}>{content}</ChatsSection>);
  expect(view.queryByText("A chat")).toBeNull();
  view.rerender(<ChatsSection activeChatId="two" onNewChat={() => {}}>{content}</ChatsSection>);
  expect(view.getByText("A chat")).toBeTruthy();
});

it("keeps New chat accessible when collapsed", () => {
  const onNewChat = vi.fn();
  localStorage.setItem("bots:chats-collapsed", "true");
  const view = render(<ChatsSection activeChatId={null} onNewChat={onNewChat}>{content}</ChatsSection>);
  fireEvent.click(view.getByRole("button", { name: "New unconnected chat" }));
  expect(onNewChat).toHaveBeenCalledOnce();
  expect(view.getByText("A chat")).toBeTruthy();
});
