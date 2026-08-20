import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import questionSetsRouter from "./question-sets";
import aiRouter from "./ai";
import radioRouter from "./radio";
import reportsRouter from "./reports";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/users", usersRouter);
router.use("/question-sets", questionSetsRouter);
router.use("/ai", aiRouter);
router.use("/radio", radioRouter);
router.use("/reports", reportsRouter);

export default router;
