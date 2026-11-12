CREATE TABLE "margins_latest" (
	"broker" "broker" PRIMARY KEY NOT NULL,
	"cash" numeric NOT NULL,
	"used" numeric NOT NULL,
	"net" numeric NOT NULL,
	"as_of" timestamp with time zone NOT NULL
);
