import { defineNuxtPlugin } from "#app/nuxt";

const cookieName = "vitehub-fw";
const maxAge = 60 * 60 * 24 * 365;

export default defineNuxtPlugin(() => {
  const handleClick = (event: MouseEvent) => {
    if (window.location.pathname !== "/") {
      return;
    }

    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-framework][data-framework-switch='landing']");
    if (!button) {
      return;
    }

    const framework = button.dataset.framework;
    if (!framework) {
      return;
    }

    const currentCookie = document.cookie
      .split("; ")
      .find(entry => entry.startsWith(`${cookieName}=`))
      ?.split("=")[1];

    if (currentCookie === framework) {
      return;
    }

    document.cookie = `${cookieName}=${framework}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
    window.location.reload();
  };

  document.addEventListener("click", handleClick);
});
